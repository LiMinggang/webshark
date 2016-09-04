/* sharkd_session.c
 *
 * Copyright (C) 2016 Jakub Zawadzki
 *
 * This program is free software: you can redistribute it and/or  modify
 * it under the terms of the GNU Affero General Public License, version 3,
 * as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <config.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <locale.h>

#include <glib.h>

#include <wsutil/jsmn.h>

#include <file.h>
#include <epan/exceptions.h>
#include <epan/color_filters.h>
#include <epan/prefs.h>
#include <wiretap/wtap.h>

#include <epan/stats_tree_priv.h>
#include <epan/stat_tap_ui.h>
#include <epan/conversation_table.h>

cf_status_t sharkd_cf_open(const char *fname, unsigned int type, gboolean is_tempfile, int *err);
int sharkd_load_cap_file(void);
int sharkd_retap(void);
int sharkd_filter(const char *dftext, guint8 **result);
int sharkd_dissect_columns(int framenum, column_info *cinfo, gboolean dissect_color);
int sharkd_dissect_request(int framenum, void *cb, int dissect_bytes, int dissect_columns, int dissect_tree);

static struct register_ct *
_get_conversation_table_by_name(const char *name)
{
	guint count = conversation_table_get_num();
	guint i;

	/* XXX, wow O(n^2), move to libwireshark */
	for (i = 0; i < count; i++)
	{
		struct register_ct *table = get_conversation_table_by_num(i);
		const char *label = proto_get_protocol_short_name(find_protocol_by_id(get_conversation_proto_id(table)));

		if (!strcmp(label, name))
			return table;
	}

	return NULL;
}

static const char *
json_find_attr(const char *buf, const jsmntok_t *tokens, int count, const char *attr)
{
	int i;

	for (i = 0; i < count; i += 2)
	{
		const char *tok_attr  = &buf[tokens[i + 0].start];
		const char *tok_value = &buf[tokens[i + 1].start];

		if (!strcmp(tok_attr, attr))
			return tok_value;
	}

	return NULL;
}

static void
json_puts_string(const char *str)
{
	char buf[1024];
	int i;
	int out = 0;

	buf[out++] = '"';
	for (i = 0; str[i]; i++)
	{
		if (out + 2 + 2 + 1 >= (int) sizeof(buf))
		{
			fwrite(buf, 1, out, stdout);
			out = 0;
		}

		switch (str[i])
		{
			case '\\':
			case '"':
				buf[out++] = '\\';
				buf[out++] = str[i];
				break;

			default:
				buf[out++] = str[i];
				break;
		}
	}

	buf[out++] = '"';
	fwrite(buf, 1, out, stdout);
}

static void
json_print_base64(const guint8 *data, int len)
{
	static const char base64_str[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	char buf[1024];
	int out = 0;
	int i;

	int pad = len % 3;

	buf[out++] = '"';

	for (i = 0; i < len; i += 3)
	{
		guint32 n = ((guint32)data[i]) << 16;

		if ((i + 1) < len)
			n |= ((guint32)data[i + 1]) << 8;

		if ((i + 2) < len)
			n |= data[i + 2];

		if (out + 4 + 3 + 1 >= (int) sizeof(buf))
		{
			fwrite(buf, 1, out, stdout);
			out = 0;
		}

		buf[out++] = base64_str[(n >> 18) & 63];
		buf[out++] = base64_str[(n >> 12) & 63];

		if ((i + 1) < len)
			buf[out++] = base64_str[(n >> 6) & 63];

		if ((i + 2) < len)
			buf[out++] = base64_str[n & 63];
	}

	if (pad > 0)
	{
		for (; pad < 3; pad++)
			buf[out++] = '=';
	}

	buf[out++] = '"';
	fwrite(buf, 1, out, stdout);
}

struct filter_item
{
	struct filter_item *next;

	char *filter;
	guint8 *filtered;
};

static struct filter_item *filter_list = NULL;

static const guint8 *
sharkd_session_filter_data(const char *filter)
{
	struct filter_item *l;

	for (l = filter_list; l; l = l->next)
	{
		if (!strcmp(l->filter, filter))
			return l->filtered;
	}

	{
		guint8 *filtered = NULL;

		int ret = sharkd_filter(filter, &filtered);

		if (ret == -1)
			return NULL;

		l = (struct filter_item *) g_malloc(sizeof(struct filter_item));
		l->filter = g_strdup(filter);
		l->filtered = filtered;

		l->next = filter_list;
		filter_list = l;

		return filtered;
	}
}

static void
sharkd_session_process_info_conv_cb(gpointer data, gpointer user_data)
{
	struct register_ct *table = (struct register_ct *) data;
	int *pi = (int *) user_data;

	const char *label = proto_get_protocol_short_name(find_protocol_by_id(get_conversation_proto_id(table)));

	if (get_conversation_packet_func(table))
	{
		printf("%s{", (*pi) ? "," : "");
			printf("\"name\":\"Conversation List/%s\"", label);
			printf(",\"tap\":\"conv:%s\"", label);
		printf("}");

		*pi = *pi + 1;
	}

	if (get_hostlist_packet_func(table))
	{
		printf("%s{", (*pi) ? "," : "");
			printf("\"name\":\"Endpoint/%s\"", label);
			printf(",\"tap\":\"endpt:%s\"", label);
		printf("}");

		*pi = *pi + 1;
	}
}

/**
 * sharkd_session_process_info()
 *
 * Process info request
 *
 * Output object with attributes:
 *   (m) columns - column titles
 *   (m) stats   - available statistics, array of object with attributes:
 *                  'name' - statistic name
 *                  'tap'  - sharkd tap-name for statistic
 *
 *   (m) convs   - available conversation list, array of object with attributes:
 *                  'name' - conversation name
 *                  'tap'  - sharkd tap-name for conversation
 */
static void
sharkd_session_process_info(void)
{
	extern capture_file cfile;
	int i;

	printf("{\"columns\":[");
	for (i = 0; i < cfile.cinfo.num_cols; i++)
	{
		const col_item_t *col_item = &cfile.cinfo.columns[i];

		printf("%s\"%s\"", (i) ? "," : "", col_item->col_title);
	}
	printf("]");

	printf(",\"stats\":[");
	{
		GList *cfg_list = stats_tree_get_cfg_list();
		GList *l;
		const char *sepa = "";

		for (l = cfg_list; l; l = l->next)
		{
			stats_tree_cfg *cfg = (stats_tree_cfg *) l->data;

			printf("%s{", sepa);
				printf("\"name\":\"%s\"", cfg->name);
				printf(",\"tap\":\"stat:%s\"", cfg->abbr);
			printf("}");
			sepa = ",";
		}

		g_list_free(cfg_list);
	}
	printf("]");

	printf(",\"convs\":[");
	i = 0;
	conversation_table_iterate_tables(sharkd_session_process_info_conv_cb, &i);
	printf("]");

	printf("}\n");
}

/**
 * sharkd_session_process_load()
 *
 * Process load request
 *
 * Input:
 *   (m) file - file to be loaded
 *
 * Output object with attributes:
 *   (m) err - error code
 */
static void
sharkd_session_process_load(const char *buf, const jsmntok_t *tokens, int count)
{
	const char *tok_file = json_find_attr(buf, tokens, count, "file");
	int err = 0;

	fprintf(stderr, "load: filename=%s\n", tok_file);

	if (!tok_file)
		return;

	if (sharkd_cf_open(tok_file, WTAP_TYPE_AUTO, FALSE, &err) != CF_OK)
	{
		printf("{\"err\":%d}\n", err);
		return;
	}

	TRY
	{
		err = sharkd_load_cap_file();
	}
	CATCH(OutOfMemoryError)
	{
		fprintf(stderr, "load: OutOfMemoryError\n");
		err = ENOMEM;
	}
	ENDTRY;

	printf("{\"err\":%d}\n", err);
}

/**
 * sharkd_session_process_status()
 *
 * Process status request
 *
 * Output object with attributes:
 *   (m) frames  - count of currently loaded frames
 */
static void
sharkd_session_process_status(void)
{
	extern capture_file cfile;

	printf("{\"frames\":%d", cfile.count);

	printf("}\n");
}

/**
 * sharkd_session_process_frames()
 *
 * Process frames request
 *
 * Input:
 *   (o) filter - filter to be used
 *   (o) range  - packet range to be used [TODO]
 *
 * Output array of frames with attributes:
 *   (m) c   - array of column data
 *   (m) num - frame number
 *   (m) i   - if frame is ignored
 *   (m) m   - if frame is marked
 *   (m) bg  - color filter - background color in hex
 *   (m) fg  - color filter - foreground color in hex
 */
static void
sharkd_session_process_frames(const char *buf, const jsmntok_t *tokens, int count)
{
	extern capture_file cfile;

	const char *tok_filter = json_find_attr(buf, tokens, count, "filter");

	const guint8 *filter_data = NULL;

	const char *frame_sepa = "";
	unsigned int framenum;
	int col;

	if (tok_filter)
	{
		filter_data = sharkd_session_filter_data(tok_filter);
		if (!filter_data)
			return;
	}

	printf("[");
	for (framenum = 1; framenum <= cfile.count; framenum++)
	{
		frame_data *fdata = frame_data_sequence_find(cfile.frames, framenum);

		if (filter_data && !(filter_data[framenum / 8] & (1 << (framenum % 8))))
			continue;

		sharkd_dissect_columns(framenum, &cfile.cinfo, TRUE);

		printf("%s{\"c\":[", frame_sepa);
		for (col = 0; col < cfile.cinfo.num_cols; ++col)
		{
			const col_item_t *col_item = &cfile.cinfo.columns[col];

			if (col)
				printf(",");

			json_puts_string(col_item->col_data);
		}
		printf("],\"num\":%u", framenum);

		if (fdata->flags.ignored)
			printf(",\"i\":true");

		if (fdata->flags.marked)
			printf(",\"m\":true");

		if (fdata->color_filter)
		{
			printf(",\"bg\":\"%x\"", color_t_to_rgb(&fdata->color_filter->bg_color));
			printf(",\"fg\":\"%x\"", color_t_to_rgb(&fdata->color_filter->fg_color));
		}

		printf("}");
		frame_sepa = ",";
	}
	printf("]\n");
}

static void
sharkd_session_process_tap_stats_node_cb(const stat_node *n)
{
	stat_node *node;
	const char *sepa = "";

	printf("[");
	for (node = n->children; node; node = node->next)
	{
		/* code based on stats_tree_get_values_from_node() */
		printf("%s{\"name\":\"%s\"", sepa, node->name);
		printf(",\"count\":%u", node->counter);
		if (node->counter && ((node->st_flags & ST_FLG_AVERAGE) || node->rng))
		{
			printf(",\"avg\":%.2f", ((float)node->total) / node->counter);
			printf(",\"min\":%u", node->minvalue);
			printf(",\"max\":%u", node->maxvalue);
		}

		if (node->st->elapsed)
			printf(",\"rate\":%.4f",((float)node->counter) / node->st->elapsed);

		if (node->parent && node->parent->counter)
			printf(",\"perc\":%.2f", (node->counter * 100.0) / node->parent->counter);
		else if (node->parent == &(node->st->root))
			printf(",\"perc\":100");

		if (prefs.st_enable_burstinfo && node->max_burst)
		{
			if (prefs.st_burst_showcount)
				printf(",\"burstcount\":%d", node->max_burst);
			else
				printf(",\"burstrate\":%.4f", ((double)node->max_burst) / prefs.st_burst_windowlen);

			printf(",\"bursttime\":%.3f", ((double)node->burst_time / 1000.0));
		}

		if (node->children)
		{
			printf(",\"sub\":");
			sharkd_session_process_tap_stats_node_cb(node);
		}
		printf("}");
		sepa = ",";
	}
	printf("]");
}

/**
 * sharkd_session_process_tap_stats_cb()
 *
 * Output stats tap:
 *
 *   (m) tap        - tap name
 *   (m) type:stats - tap output type
 *   (m) name       - stat name
 *   (m) stats      - array of object with attributes:
 *                  (m) name       - stat item name
 *                  (m) count      - stat item counter
 *                  (o) avg        - stat item averange value
 *                  (o) min        - stat item min value
 *                  (o) max        - stat item max value
 *                  (o) rate       - stat item rate value (ms)
 *                  (o) perc       - stat item percentage
 *                  (o) burstrate  - stat item burst rate
 *                  (o) burstcount - stat item burst count
 *                  (o) burstttme  - stat item burst start
 *                  (o) sub        - array of object with attributes like in stats node.
 */
static void
sharkd_session_process_tap_stats_cb(void *psp)
{
	stats_tree *st = (stats_tree *)psp;

	printf("{\"tap\":\"stats:%s\",\"type\":\"stats\"", st->cfg->abbr);

	printf(",\"name\":\"%s\",\"stats\":", st->cfg->name);
	sharkd_session_process_tap_stats_node_cb(&st->root);
	printf("},");
}

struct sharkd_conv_tap_data
{
	const char *type;
	conv_hash_t hash;
	gboolean resolve_name;
	gboolean resolve_port;
};

/**
 * sharkd_session_process_tap_conv_cb()
 *
 * Output conv tap:
 *   (m) tap        - tap name
 *   (m) type       - tap output type
 *   (m) proto      - protocol short name
 *   (o) filter     - filter string
 *
 *   (o) convs      - array of object with attributes:
 *                  (m) saddr - source address
 *                  (m) daddr - destination address
 *                  (o) sport - source port
 *                  (o) dport - destination port
 *                  (m) txf   - TX frame count
 *                  (m) txb   - TX bytes
 *                  (m) rxf   - RX frame count
 *                  (m) rxb   - RX bytes
 *                  (m) start - (relative) first packet time
 *                  (m) stop  - (relative) last packet time
 *
 *   (o) hosts      - array of object with attributes:
 *                  (m) host - host address
 *                  (o) port - host port
 *                  (m) txf  - TX frame count
 *                  (m) txb  - TX bytes
 *                  (m) rxf  - RX frame count
 *                  (m) rxb  - RX bytes
 */
static void
sharkd_session_process_tap_conv_cb(void *arg)
{
	conv_hash_t *hash = (conv_hash_t *) arg;
	const struct sharkd_conv_tap_data *iu = (struct sharkd_conv_tap_data *) hash->user_data;
	const char *proto;
	int proto_with_port;
	guint i;

	if (!strncmp(iu->type, "conv:", 5))
	{
		printf("{\"tap\":\"%s\",\"type\":\"conv\"", iu->type);
		printf(",\"convs\":[");
		proto = iu->type + 5;
	}
	else if (!strncmp(iu->type, "endpt:", 6))
	{
		printf("{\"tap\":\"%s\",\"type\":\"host\"", iu->type);
		printf(",\"hosts\":[");
		proto = iu->type + 6;
	}
	else
	{
		printf("{\"tap\":\"%s\",\"type\":\"err\"", iu->type);
		proto = "";
	}

	proto_with_port = (!strcmp(proto, "TCP") || !strcmp(proto, "UDP") || !strcmp(proto, "SCTP"));

	if (iu->hash.conv_array != NULL && !strncmp(iu->type, "conv:", 5))
	{
		for (i = 0; i < iu->hash.conv_array->len; i++)
		{
			conv_item_t *iui = &g_array_index(iu->hash.conv_array, conv_item_t, i);
			char *src_addr, *dst_addr;
			char *src_port, *dst_port;
			char *filter_str;

			printf("%s{", i ? "," : "");

			printf("\"saddr\":\"%s\"",  (src_addr = get_conversation_address(NULL, &iui->src_address, iu->resolve_name)));
			printf(",\"daddr\":\"%s\"", (dst_addr = get_conversation_address(NULL, &iui->dst_address, iu->resolve_name)));

			if (proto_with_port)
			{
				printf(",\"sport\":\"%s\"", (src_port = get_conversation_port(NULL, iui->src_port, iui->ptype, iu->resolve_port)));
				printf(",\"dport\":\"%s\"", (dst_port = get_conversation_port(NULL, iui->dst_port, iui->ptype, iu->resolve_port)));

				wmem_free(NULL, src_port);
				wmem_free(NULL, dst_port);
			}

			printf(",\"rxf\":%llu", (long long unsigned) iui->rx_frames);
			printf(",\"rxb\":%llu", (long long unsigned) iui->rx_bytes);

			printf(",\"txf\":%llu", (long long unsigned) iui->tx_frames);
			printf(",\"txb\":%llu", (long long unsigned) iui->tx_bytes);

			printf(",\"start\":%.9f", nstime_to_sec(&iui->start_time));
			printf(",\"stop\":%.9f", nstime_to_sec(&iui->stop_time));

			filter_str = get_conversation_filter(iui, CONV_DIR_A_TO_FROM_B);
			if (filter_str)
			{
				printf(",\"filter\":\"%s\"", filter_str);
				g_free(filter_str);
			}

			wmem_free(NULL, src_addr);
			wmem_free(NULL, dst_addr);

			printf("}");
		}
	}
	else if (iu->hash.conv_array != NULL && !strncmp(iu->type, "endpt:", 6))
	{
		for (i = 0; i < iu->hash.conv_array->len; i++)
		{
			hostlist_talker_t *host = &g_array_index(iu->hash.conv_array, hostlist_talker_t, i);
			char *host_str, *port_str;
			char *filter_str;

			printf("%s{", i ? "," : "");

			printf("\"host\":\"%s\"", (host_str = get_conversation_address(NULL, &host->myaddress, iu->resolve_name)));

			if (proto_with_port)
			{
				printf(",\"port\":\"%s\"", (port_str = get_conversation_port(NULL, host->port, host->ptype, iu->resolve_port)));

				wmem_free(NULL, port_str);
			}

			printf(",\"rxf\":%llu", (long long unsigned) host->rx_frames);
			printf(",\"rxb\":%llu", (long long unsigned) host->rx_bytes);

			printf(",\"txf\":%llu", (long long unsigned) host->tx_frames);
			printf(",\"txb\":%llu", (long long unsigned) host->tx_bytes);

			filter_str = get_hostlist_filter(host);
			if (filter_str)
			{
				printf(",\"filter\":\"%s\"", filter_str);
				g_free(filter_str);
			}

			wmem_free(NULL, host_str);

			printf("}");
		}
	}

	printf("],\"proto\":\"%s\"},", proto);
}

/**
 * sharkd_session_process_tap()
 *
 * Process tap request
 *
 * Input:
 *   (m) tap0         - First tap request
 *   (o) tap1...tap15 - Other tap requests
 *
 * Output object with attributes:
 *   (m) taps  - array of object with attributes:
 *                  (m) tap  - tap name
 *                  (m) type - tap output type
 *                  ...
 *                  for type:stats see sharkd_session_process_tap_stats_cb()
 *                  for type:conv see sharkd_session_process_tap_conv_cb()
 *                  for type:host see sharkd_session_process_tap_conv_cb()
 *
 *   (m) err   - error code
 */
static void
sharkd_session_process_tap(char *buf, const jsmntok_t *tokens, int count)
{
	void *taps_data[16];
	int taps_count = 0;
	int i;

	for (i = 0; i < 16; i++)
	{
		char tapbuf[32];
		const char *tok_tap;

		tap_packet_cb tap_func = NULL;
		void *tap_data = NULL;
		const char *tap_filter = "";
		GString *tap_error = NULL;

		taps_data[i] = NULL;

		snprintf(tapbuf, sizeof(tapbuf), "tap%d", i);
		tok_tap = json_find_attr(buf, tokens, count, tapbuf);
		if (!tok_tap)
			break;

		if (!strncmp(tok_tap, "stat:", 5))
		{
			stats_tree_cfg *cfg = stats_tree_get_cfg_by_abbr(tok_tap + 5);
			stats_tree *st;

			if (!cfg)
			{
				fprintf(stderr, "sharkd_session_process_tap() stat %s not found\n", tok_tap + 5);
				continue;
			}

			st = stats_tree_new(cfg, NULL, tap_filter);

			tap_error = register_tap_listener(st->cfg->tapname, st, st->filter, st->cfg->flags, stats_tree_reset, stats_tree_packet, sharkd_session_process_tap_stats_cb);

			tap_data = st;

			if (!tap_error && cfg->init)
				cfg->init(st);
		}
		else if (!strncmp(tok_tap, "conv:", 5) || !strncmp(tok_tap, "endpt:", 6))
		{
			struct register_ct *ct = NULL;
			const char *ct_tapname;
			struct sharkd_conv_tap_data *ct_data;

			if (!strncmp(tok_tap, "conv:", 5))
			{
				ct = _get_conversation_table_by_name(tok_tap + 5);

				if (!ct || !(tap_func = get_conversation_packet_func(ct)))
				{
					fprintf(stderr, "sharkd_session_process_tap() conv %s not found\n", tok_tap + 5);
					continue;
				}
			}
			else if (!strncmp(tok_tap, "endpt:", 6))
			{
				ct = _get_conversation_table_by_name(tok_tap + 6);

				if (!ct || !(tap_func = get_hostlist_packet_func(ct)))
				{
					fprintf(stderr, "sharkd_session_process_tap() endpt %s not found\n", tok_tap + 5);
					continue;
				}
			}
			else
			{
				fprintf(stderr, "sharkd_session_process_tap() conv/endpt(?): %s not found\n", tok_tap);
				continue;
			}

			ct_tapname = proto_get_protocol_filter_name(get_conversation_proto_id(ct));

			ct_data = (struct sharkd_conv_tap_data *) g_malloc0(sizeof(struct sharkd_conv_tap_data));
			ct_data->type = tok_tap;
			ct_data->hash.user_data = ct_data;

			/* XXX: make configurable */
			ct_data->resolve_name = TRUE;
			ct_data->resolve_port = TRUE;

			tap_error = register_tap_listener(ct_tapname, &ct_data->hash, tap_filter, 0, NULL, tap_func, sharkd_session_process_tap_conv_cb);

			tap_data = &ct_data->hash;
		}
		else
		{
			fprintf(stderr, "sharkd_session_process_tap() %s not recognized\n", tok_tap);
			continue;
		}

		if (tap_error)
		{
			/* XXX, tap data memleaks */
			fprintf(stderr, "sharkd_session_process_tap() name=%s error=%s", tok_tap, tap_error->str);
			g_string_free(tap_error, TRUE);
			continue;
		}

		taps_data[i] = tap_data;
		taps_count++;
	}

	fprintf(stderr, "sharkd_session_process_tap() count=%d\n", taps_count);
	if (taps_count == 0)
		return;

	printf("{\"taps\":[");
	sharkd_retap();
	printf("null],\"err\":0}\n");

	for (i = 0; i < 16; i++)
	{
		if (taps_data[i])
			remove_tap_listener(taps_data[i]);

		/* XXX, taps data memleaks */
	}
}

static void
sharkd_session_process_frame_cb_tree(proto_tree *tree)
{
	proto_node *node;
	const char *sepa = "";

	printf("[");
	for (node = tree->first_child; node; node = node->next)
	{
		field_info *finfo = PNODE_FINFO(node);

		if (!finfo)
			continue;

		/* XXX, for now always skip hidden */
		if (FI_GET_FLAG(finfo, FI_HIDDEN))
			continue;

		printf("%s{", sepa);

		printf("\"l\":");
		if (!finfo->rep)
		{
			char label_str[ITEM_LABEL_LENGTH];

			label_str[0] = '\0';
			proto_item_fill_label(finfo, label_str);
			json_puts_string(label_str);
		}
		else
		{
			json_puts_string(finfo->rep->representation);
		}

		if (finfo->hfinfo && finfo->hfinfo->type == FT_PROTOCOL)
			printf(",\"t\":\"proto\"");

		if (FI_GET_FLAG(finfo, PI_SEVERITY_MASK))
		{
			const char *severity = NULL;

			switch (FI_GET_FLAG(finfo, PI_SEVERITY_MASK))
			{
				case PI_COMMENT:
					severity = "comment";
					break;

				case PI_CHAT:
					severity = "chat";
					break;

				case PI_NOTE:
					severity = "note";
					break;

				case PI_WARN:
					severity = "warn";
					break;

				case PI_ERROR:
					severity = "error";
					break;
			}
			g_assert(severity != NULL);

			printf(",\"s\":\"%s\"", severity);
		}

		if (((proto_tree *) node)->first_child) {
			printf(",\"n\":");
			sharkd_session_process_frame_cb_tree((proto_tree *) node);
		}

		printf("}");
		sepa = ",";
	}
	printf("]");
}

static void
sharkd_session_process_frame_cb(proto_tree *tree, struct epan_column_info *cinfo, const GSList *data_src)
{
	printf("{");

	printf("\"err\":0");

	if (tree)
	{
		printf(",\"tree\":");
		sharkd_session_process_frame_cb_tree(tree);
	}

	if (cinfo)
	{
		int col;

		printf(",\"col\":[");
		for (col = 0; col < cinfo->num_cols; ++col)
		{
			const col_item_t *col_item = &cinfo->columns[col];

			printf("%s\"%s\"", (col) ? "," : "", col_item->col_data);
		}
		printf("]");
	}

	if (data_src)
	{
		struct data_source *src = (struct data_source *)data_src->data;

		tvbuff_t *tvb;
		guint length;

		printf(",\"bytes\":");

		tvb = get_data_source_tvb(src);

		length = tvb_captured_length(tvb);
		if (length != 0)
		{
			const guchar *cp = tvb_get_ptr(tvb, 0, length);

			/* XXX pi.fd->flags.encoding */

			json_print_base64(cp, length);
		}
	}

	printf("}\n");
}

/**
 * sharkd_session_process_frame()
 *
 * Process frame request
 *
 * Input:
 *   (m) frame - requested frame number
 *   (o) proto - set if output frame tree
 *   (o) columns - set if output frame columns
 *   (o) bytes - set if output frame bytes
 *
 * Output object with attributes:
 *   (m) err   - 0 if succeed
 *   (o) tree  - array of frame nodes with attributes:
 *                  l - label
 *                  t: 'proto'
 *                  s - severity
 *                  n - array of subtree nodes
 *
 *   (o) col   - array of column data
 *   (o) bytes - array of frame bytes [XXX, will be changed to support multiple bytes pane]
 */
static void
sharkd_session_process_frame(char *buf, const jsmntok_t *tokens, int count)
{
	extern capture_file cfile;

	const char *tok_frame = json_find_attr(buf, tokens, count, "frame");
	int tok_proto   = (json_find_attr(buf, tokens, count, "proto") != NULL);
	int tok_bytes   = (json_find_attr(buf, tokens, count, "bytes") != NULL);
	int tok_columns = (json_find_attr(buf, tokens, count, "columns") != NULL);

	int framenum;

	if (!tok_frame || !(framenum = atoi(tok_frame)))
		return;

	sharkd_dissect_request(framenum, &sharkd_session_process_frame_cb, tok_bytes, tok_columns, tok_proto);
}

/**
 * sharkd_session_process_check()
 *
 * Process check request.
 *
 * Input:
 *   (o) filter - filter to be checked
 *
 * Output object with attributes:
 *   (m) err - always 0
 *   (o) filter - 'ok', 'warn' or error message
 */
static int
sharkd_session_process_check(char *buf, const jsmntok_t *tokens, int count)
{
	const char *tok_filter = json_find_attr(buf, tokens, count, "filter");

	printf("{\"err\":0");
	if (tok_filter != NULL)
	{
		char *err_msg = NULL;
		dfilter_t *dfp;

		if (dfilter_compile(tok_filter, &dfp, &err_msg))
		{
			const char *s = "ok";

			if (dfilter_deprecated_tokens(dfp))
				s = "warn";

			printf(",\"filter\":\"%s\"", s);
			dfilter_free(dfp);
		}
		else
		{
			printf(",\"filter\":");
			json_puts_string(err_msg);
			g_free(err_msg);
		}
	}

	printf("}\n");
	return 0;
}

static void
sharkd_session_process(char *buf, const jsmntok_t *tokens, int count)
{
	int i;

	/* sanity check, and split strings */
	if (count < 1 || tokens[0].type != JSMN_OBJECT)
	{
		fprintf(stderr, "sanity check(1): [0] not object\n");
		return;
	}

	/* don't need [0] token */
	tokens++;
	count--;

	if (count & 1)
	{
		fprintf(stderr, "sanity check(2): %d not even\n", count);
		return;
	}

	for (i = 0; i < count; i += 2)
	{
		if (tokens[i].type != JSMN_STRING)
		{
			fprintf(stderr, "sanity check(3): [%d] not string\n", i);
			return;
		}

		buf[tokens[i + 0].end] = '\0';
		buf[tokens[i + 1].end] = '\0';
	}

	{
		const char *tok_req = json_find_attr(buf, tokens, count, "req");

		if (!tok_req)
		{
			fprintf(stderr, "sanity check(4): no \"req\"!\n");
			return;
		}

		if (!strcmp(tok_req, "load"))
			sharkd_session_process_load(buf, tokens, count);
		else if (!strcmp(tok_req, "status"))
			sharkd_session_process_status();
		else if (!strcmp(tok_req, "info"))
			sharkd_session_process_info();
		else if (!strcmp(tok_req, "check"))
			sharkd_session_process_check(buf, tokens, count);
		else if (!strcmp(tok_req, "frames"))
			sharkd_session_process_frames(buf, tokens, count);
		else if (!strcmp(tok_req, "tap"))
			sharkd_session_process_tap(buf, tokens, count);
		else if (!strcmp(tok_req, "frame"))
			sharkd_session_process_frame(buf, tokens, count);
		else if (!strcmp(tok_req, "bye"))
			_Exit(0);
		else
			fprintf(stderr, "::: req = %s\n", tok_req);

		printf("\n");
	}
}

int
sharkd_session_main(void)
{
	char buf[16 * 1024];
	jsmntok_t *tokens = NULL;
	int tokens_max = -1;

	fprintf(stderr, "Hello in child!\n");
	setlinebuf(stdout);
	setlocale(LC_ALL, "C");

	while (fgets(buf, sizeof(buf), stdin))
	{
		/* every command is line seperated JSON */

		jsmn_parser p;
		int ret;

		jsmn_init(&p);

		ret = jsmn_parse(&p, buf, strlen(buf), NULL, 0);
		if (ret < 0)
		{
			fprintf(stderr, "invalid JSON -> closing\n");
			return 1;
		}

		fprintf(stderr, "JSON: %d tokens\n", ret);
		ret += 1;

		if (tokens == NULL || tokens_max < ret)
		{
			tokens_max = ret;
			tokens = (jsmntok_t *) g_realloc(tokens, sizeof(jsmntok_t) * tokens_max);
		}

		memset(tokens, 0, ret * sizeof(jsmntok_t));

		jsmn_init(&p);
		ret = jsmn_parse(&p, buf, strlen(buf), tokens, ret);

		if (ret < 0)
		{
			fprintf(stderr, "invalid JSON(2) -> closing\n");
			return 2;
		}

		sharkd_session_process(buf, tokens, ret);
	}

	g_free(tokens);

	return 0;
}
