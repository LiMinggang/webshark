/* sharkd_session.c
 *
 * Copyright (C) 2016 Jakub Zawadzki
 *
 * Wireshark - Network traffic analyzer
 * By Gerald Combs <gerald@wireshark.org>
 * Copyright 1998 Gerald Combs
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

#include <config.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#include <glib.h>

#include <wsutil/wsjsmn.h>
#include <wsutil/ws_printf.h>

#include <file.h>
#include <epan/exceptions.h>
#include <epan/color_filters.h>
#include <epan/prefs.h>
#include <epan/prefs-int.h>
#include <epan/uat-int.h>
#include <wiretap/wtap.h>

#include <epan/column.h>

#include <epan/stats_tree_priv.h>
#include <epan/stat_tap_ui.h>
#include <epan/conversation_table.h>

#include <epan/dissectors/packet-h225.h>
#include <epan/rtp_pt.h>
#include <ui/voip_calls.h>
#include <ui/rtp_stream.h>
#include <ui/tap-rtp-common.h>
#include <epan/to_str.h>

#ifdef HAVE_GEOIP
# include <GeoIP.h>
# include <epan/geoip_db.h>
# include <wsutil/pint.h>
#endif

#include <wsutil/strtoi.h>

#include "sharkd.h"

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

static void
json_unescape_str(char *input)
{
	char *output = input;

	while (*input)
	{
		char ch = *input++;

		if (ch == '\\')
		{
			/* TODO, add more escaping rules */
			ch = *input++;
		}

		*output = ch;
		output++;
	}

	*output = '\0';
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
	int i;

	if (str == NULL)
		str = "";

	putchar('"');
	for (i = 0; str[i]; i++)
	{
		switch (str[i])
		{
			case '\\':
			case '"':
				putchar('\\');
				putchar(str[i]);
				break;

			case '\n':
				putchar('\\');
				putchar('n');
				break;

			default:
				putchar(str[i]);
				break;
		}
	}

	putchar('"');
}

static void
json_print_base64(const guint8 *data, int len)
{
	int i;
	int base64_state1 = 0;
	int base64_state2 = 0;
	gsize wrote;
	gchar buf[(1 / 3 + 1) * 4 + 4];

	putchar('"');

	for (i = 0; i < len; i++)
	{
		wrote = g_base64_encode_step(&data[i], 1, FALSE, buf, &base64_state1, &base64_state2);
		if (wrote > 0)
			fwrite(buf, 1, wrote, stdout);
	}

	wrote = g_base64_encode_close(FALSE, buf, &base64_state1, &base64_state2);
	if (wrote > 0)
		fwrite(buf, 1, wrote, stdout);

	putchar('"');
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
 *   (m) columns - available column formats, array of object with attributes:
 *                  'name'   - column name
 *                  'format' - column format-name
 *
 *   (m) stats   - available statistics, array of object with attributes:
 *                  'name' - statistic name
 *                  'tap'  - sharkd tap-name for statistic
 *
 *   (m) convs   - available conversation list, array of object with attributes:
 *                  'name' - conversation name
 *                  'tap'  - sharkd tap-name for conversation
 *
 *   (m) taps - available taps, array of object with attributes:
 *                  'name' - tap name
 *                  'tap'  - sharkd tap-name
 *
 *   (m) ftypes   - conversation table for FT_ number to string
 */
static void
sharkd_session_process_info(void)
{
	int i;

	printf("{\"columns\":[");
	for (i = 0; i < NUM_COL_FMTS; i++)
	{
		const char *col_format = col_format_to_string(i);
		const char *col_descr  = col_format_desc(i);

		printf("%s{", (i) ? "," : "");
			printf("\"name\":\"%s\"", col_descr);
			printf(",\"format\":\"%s\"", col_format);
		printf("}");
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

	printf(",\"ftypes\":[");
	for (i = 0; i < FT_NUM_TYPES; i++)
	{
		if (i)
			printf(",");
		json_puts_string(ftype_name((ftenum_t) i));
	}
	printf("]");

	printf(",\"version\":");
	json_puts_string(sharkd_version());

	printf(",\"convs\":[");
	i = 0;
	conversation_table_iterate_tables(sharkd_session_process_info_conv_cb, &i);
	printf("]");

	printf(",\"taps\":[");
	{
		printf("{\"name\":\"%s\",\"tap\":\"%s\"}", "VoIP calls", "voip-calls");
		printf(",{\"name\":\"%s\",\"tap\":\"%s\"}", "RTP streams", "rtp-streams");
	}
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
	printf("{\"frames\":%d", cfile.count);

	printf("}\n");
}

struct sharkd_analyse_data
{
	GHashTable *protocols_set;
	nstime_t *first_time;
	nstime_t *last_time;
};

static void
sharkd_session_process_analyse_cb(packet_info *pi, proto_tree *tree, struct epan_column_info *cinfo, const GSList *data_src, void *data)
{
	struct sharkd_analyse_data *analyser = (struct sharkd_analyse_data *) data;
	frame_data *fdata = pi->fd;

	(void) tree;
	(void) cinfo;
	(void) data_src;

	if (analyser->first_time == NULL || nstime_cmp(&fdata->abs_ts, analyser->first_time) < 0)
		analyser->first_time = &fdata->abs_ts;

	if (analyser->last_time == NULL || nstime_cmp(&fdata->abs_ts, analyser->last_time) > 0)
		analyser->last_time = &fdata->abs_ts;

	if (pi->layers)
	{
		wmem_list_frame_t *frame;

		for (frame = wmem_list_head(pi->layers); frame; frame = wmem_list_frame_next(frame))
		{
			int proto_id = GPOINTER_TO_UINT(wmem_list_frame_data(frame));

			if (!g_hash_table_lookup_extended(analyser->protocols_set, GUINT_TO_POINTER(proto_id), NULL, NULL))
			{
				g_hash_table_insert(analyser->protocols_set, GUINT_TO_POINTER(proto_id), GUINT_TO_POINTER(proto_id));

				if (g_hash_table_size(analyser->protocols_set) != 1)
					printf(",");
				json_puts_string(proto_get_protocol_filter_name(proto_id));
			}
		}
	}

}

/**
 * sharkd_session_process_status()
 *
 * Process analyse request
 *
 * Output object with attributes:
 *   (m) frames  - count of currently loaded frames
 *   (m) protocols - protocol list
 *   (m) first     - earliest frame time
 *   (m) last      - latest frame time
 */
static void
sharkd_session_process_analyse(void)
{
	unsigned int framenum;
	struct sharkd_analyse_data analyser;

	analyser.first_time = NULL;
	analyser.last_time  = NULL;
	analyser.protocols_set = g_hash_table_new(NULL /* g_direct_hash() */, NULL /* g_direct_equal */);

	printf("{\"frames\":%d", cfile.count);

	printf(",\"protocols\":[");
	for (framenum = 1; framenum <= cfile.count; framenum++)
		sharkd_dissect_request(framenum, &sharkd_session_process_analyse_cb, 0, 0, 0, &analyser);
	printf("]");

	if (analyser.first_time)
		printf(",\"first\":%.9f", nstime_to_sec(analyser.first_time));

	if (analyser.last_time)
		printf(",\"last\":%.9f", nstime_to_sec(analyser.last_time));

	printf("}\n");

	g_hash_table_destroy(analyser.protocols_set);
}

extern void col_finalize(column_info *cinfo);

static column_info *
sharkd_session_create_columns(column_info *cinfo, const char *buf, const jsmntok_t *tokens, int count)
{
	int columns_fmt[32];
	const char *custom_field[32];

	int i, cols;

	for (i = 0; i < 32; i++)
	{
		const char *tok_column;
		char tok_column_name[64];
		const char *custom_sepa;

		snprintf(tok_column_name, sizeof(tok_column_name), "column%d", i);
		tok_column = json_find_attr(buf, tokens, count, tok_column_name);

		if (tok_column == NULL)
			break;

		if ((custom_sepa = strchr(tok_column, ':')))
		{
			columns_fmt[i] = COL_CUSTOM;
			custom_field[i] = tok_column;

			/* TODO, verify */
		}
		else
		{
			columns_fmt[i] = atoi(tok_column);
			if (columns_fmt[i] < 0 || columns_fmt[i] >= NUM_COL_FMTS)
				return NULL;

			/* if custom, that it shouldn't be just custom number -> error */
			if (columns_fmt[i] == COL_CUSTOM)
				return NULL;
		}
	}

	cols = i;

	col_setup(cinfo, cols);

	for (i = 0; i < cols; i++)
	{
		col_item_t *col_item = &cinfo->columns[i];

		col_item->col_fmt = columns_fmt[i];
		col_item->col_title = NULL; /* no need for title */

		if (col_item->col_fmt == COL_CUSTOM)
		{
			char *tmp = g_strdup(custom_field[i]);
			char *sepa = strchr(tmp, ':');

			col_item->col_custom_fields = tmp;
			col_item->col_custom_occurrence = atoi(sepa + 1);

			*sepa = '\0';
		}

		col_item->col_fence = 0;
	}

	col_finalize(cinfo);

	return cinfo;
}

/**
 * sharkd_session_process_frames()
 *
 * Process frames request
 *
 * Input:
 *   (o) column0...columnXX - requested columns either number in range [0..NUM_COL_FMTS), or custom.
 *                            If column0 not specified default columns will be used.
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
	const char *tok_filter = json_find_attr(buf, tokens, count, "filter");
	const char *tok_column = json_find_attr(buf, tokens, count, "column0");

	const guint8 *filter_data = NULL;

	const char *frame_sepa = "";
	unsigned int framenum;
	int col;

	column_info *cinfo = &cfile.cinfo;
	column_info user_cinfo;

	if (tok_column)
	{
		memset(&user_cinfo, 0, sizeof(user_cinfo));
		cinfo = sharkd_session_create_columns(&user_cinfo, buf, tokens, count);
		if (!cinfo)
			return;
	}

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

		sharkd_dissect_columns(framenum, cinfo, (fdata->color_filter == NULL));

		printf("%s{\"c\":[", frame_sepa);
		for (col = 0; col < cinfo->num_cols; ++col)
		{
			const col_item_t *col_item = &cinfo->columns[col];

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

	if (cinfo != &cfile.cinfo)
		col_cleanup(cinfo);
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

static int
sharkd_session_geoip_addr(address *addr, const char *suffix)
{
	int with_geoip = 0;

	(void) addr;
	(void) suffix;

#ifdef HAVE_GEOIP
	if (addr->type == AT_IPv4)
	{
		guint32 ip = pntoh32(addr->data);

		guint num_dbs = geoip_db_num_dbs();
		guint dbnum;

		for (dbnum = 0; dbnum < num_dbs; dbnum++)
		{
			const char *geoip_key = NULL;
			char *geoip_val;

			int db_type = geoip_db_type(dbnum);

			switch (db_type)
			{
				case GEOIP_COUNTRY_EDITION:
					geoip_key = "geoip_country";
					break;

				case GEOIP_CITY_EDITION_REV0:
				case GEOIP_CITY_EDITION_REV1:
					geoip_key = "geoip_city";
					break;

				case GEOIP_ORG_EDITION:
					geoip_key = "geoip_org";
					break;

				case GEOIP_ISP_EDITION:
					geoip_key = "geoip_isp";
					break;

				case GEOIP_ASNUM_EDITION:
					geoip_key = "geoip_as";
					break;

				case WS_LAT_FAKE_EDITION:
					geoip_key = "geoip_lat";
					break;

				case WS_LON_FAKE_EDITION:
					geoip_key = "geoip_lon";
					break;
			}

			if (geoip_key && (geoip_val = geoip_db_lookup_ipv4(dbnum, ip, NULL)))
			{
				printf(",\"%s%s\":", geoip_key, suffix);
				json_puts_string(geoip_val);
				with_geoip = 1;
			}
		}
	}
#ifdef HAVE_GEOIP_V6
	if (addr->type == AT_IPv6)
	{
		const struct e_in6_addr *ip6 = (const struct e_in6_addr *) addr->data;

		guint num_dbs = geoip_db_num_dbs();
		guint dbnum;

		for (dbnum = 0; dbnum < num_dbs; dbnum++)
		{
			const char *geoip_key = NULL;
			char *geoip_val;

			int db_type = geoip_db_type(dbnum);

			switch (db_type)
			{
				case GEOIP_COUNTRY_EDITION_V6:
					geoip_key = "geoip_country";
					break;
#if NUM_DB_TYPES > 31
				case GEOIP_CITY_EDITION_REV0_V6:
				case GEOIP_CITY_EDITION_REV1_V6:
					geoip_key = "geoip_city";
					break;

				case GEOIP_ORG_EDITION_V6:
					geoip_key = "geoip_org";
					break;

				case GEOIP_ISP_EDITION_V6:
					geoip_key = "geoip_isp";
					break;

				case GEOIP_ASNUM_EDITION_V6:
					geoip_key = "geoip_as";
					break;
#endif /* DB_NUM_TYPES */
				case WS_LAT_FAKE_EDITION:
					geoip_key = "geoip_lat";
					break;

				case WS_LON_FAKE_EDITION:
					geoip_key = "geoip_lon";
					break;
			}

			if (geoip_key && (geoip_val = geoip_db_lookup_ipv6(dbnum, *ip6, NULL)))
			{
				printf(",\"%s%s\":", geoip_key, suffix);
				json_puts_string(geoip_val);
				with_geoip = 1;
			}
		}
	}
#endif /* HAVE_GEOIP_V6 */
#endif /* HAVE_GEOIP */

	return with_geoip;
}

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

	int with_geoip = 0;

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

			printf(",\"rxf\":%" G_GUINT64_FORMAT, iui->rx_frames);
			printf(",\"rxb\":%" G_GUINT64_FORMAT, iui->rx_bytes);

			printf(",\"txf\":%" G_GUINT64_FORMAT, iui->tx_frames);
			printf(",\"txb\":%" G_GUINT64_FORMAT, iui->tx_bytes);

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

			if (sharkd_session_geoip_addr(&(iui->src_address), "1"))
				with_geoip = 1;
			if (sharkd_session_geoip_addr(&(iui->dst_address), "2"))
				with_geoip = 1;

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

			printf(",\"rxf\":%" G_GUINT64_FORMAT, host->rx_frames);
			printf(",\"rxb\":%" G_GUINT64_FORMAT, host->rx_bytes);

			printf(",\"txf\":%" G_GUINT64_FORMAT, host->tx_frames);
			printf(",\"txb\":%" G_GUINT64_FORMAT, host->tx_bytes);

			filter_str = get_hostlist_filter(host);
			if (filter_str)
			{
				printf(",\"filter\":\"%s\"", filter_str);
				g_free(filter_str);
			}

			wmem_free(NULL, host_str);

			if (sharkd_session_geoip_addr(&(host->myaddress), ""))
				with_geoip = 1;
			printf("}");
		}
	}

	printf("],\"proto\":\"%s\",\"geoip\":%s},", proto, with_geoip ? "true" : "false");
}

/**
 * sharkd_session_process_tap_rtp_cb()
 *
 * Output RTP streams tap:
 *   (m) tap        - tap name
 *   (m) type       - tap output type
 *   (m) streams    - array of object with attributes:
 *                  (m) ssrc        - RTP synchronization source identifier
 *                  (m) payload     - stream payload
 *                  (m) saddr       - source address
 *                  (m) sport       - source port
 *                  (m) daddr       - destination address
 *                  (m) dport       - destination port
 *                  (m) pkts        - packets count
 *                  (m) max_delta   - max delta (ms)
 *                  (m) max_jitter  - max jitter (ms)
 *                  (m) mean_jitter - mean jitter (ms)
 *                  (m) expectednr  -
 *                  (m) totalnr     -
 *                  (m) problem     - if analyser found the problem
 *                  (m) ipver       - address IP version (4 or 6)
 */
static void
sharkd_session_process_tap_rtp_cb(void *arg)
{
	rtpstream_tapinfo_t *rtp_tapinfo = (rtpstream_tapinfo_t *) arg;

	GList *listx;
	const char *sepa = "";

	printf("{\"tap\":\"%s\",\"type\":\"%s\"", "rtp-streams", "rtp-streams");

	printf(",\"streams\":[");
	for (listx = g_list_first(rtp_tapinfo->strinfo_list); listx; listx = listx->next)
	{
		rtp_stream_info_t *streaminfo = (rtp_stream_info_t *) listx->data;

		char *src_addr, *dst_addr;
		char *payload;
		guint32 expected;

		src_addr = address_to_display(NULL, &(streaminfo->src_addr));
		dst_addr = address_to_display(NULL, &(streaminfo->dest_addr));

		if (streaminfo->payload_type_name != NULL)
			payload = wmem_strdup(NULL, streaminfo->payload_type_name);
		else
			payload = val_to_str_ext_wmem(NULL, streaminfo->payload_type, &rtp_payload_type_short_vals_ext, "Unknown (%u)");

		printf("%s{\"ssrc\":%u", sepa, streaminfo->ssrc);
		printf(",\"payload\":\"%s\"", payload);

		printf(",\"saddr\":\"%s\"", src_addr);
		printf(",\"sport\":%u", streaminfo->src_port);

		printf(",\"daddr\":\"%s\"", dst_addr);
		printf(",\"dport\":%u", streaminfo->dest_port);

		printf(",\"pkts\":%u", streaminfo->packet_count);

		printf(",\"max_delta\":%f", streaminfo->rtp_stats.max_delta);
		printf(",\"max_jitter\":%f", streaminfo->rtp_stats.max_jitter);
		printf(",\"mean_jitter\":%f", streaminfo->rtp_stats.mean_jitter);

		expected = (streaminfo->rtp_stats.stop_seq_nr + streaminfo->rtp_stats.cycles * 65536) - streaminfo->rtp_stats.start_seq_nr + 1;
		printf(",\"expectednr\":%u", expected);
		printf(",\"totalnr\":%u", streaminfo->rtp_stats.total_nr);

		printf(",\"problem\":%s", streaminfo->problem ? "true" : "false");

		/* for filter */
		printf(",\"ipver\":%d", (streaminfo->src_addr.type == AT_IPv6) ? 6 : 4);

		wmem_free(NULL, src_addr);
		wmem_free(NULL, dst_addr);
		wmem_free(NULL, payload);

		printf("}");
		sepa = ",";
	}
	printf("]},");
}

/**
 * sharkd_session_process_tap_voip_calls_cb()
 *
 * Output VoIP tap:
 *   (m) tap        - tap name
 *   (m) type       - tap output type
 *   (m) completed  - number of completed calls
 *   (m) rejected   - number of rejected calls
 *   (m) startpkts  - number of start packets
 *   (m) calls      - array of object with attributes:
 *                  (m) start   - start relative time
 *                  (m) stop    - stop relative time
 *                  (m) pkts    - number of packets
 *                  (m) initial - inital speaker address
 *                  (m) from    - from identity
 *                  (m) to      - to identity
 *                  (m) proto   - voip protocol
 *                  (o) comment - dissector comment (?)
 *                  (o) filter  - filter for filtering this call
 */
static void
sharkd_session_process_tap_voip_calls_cb(void *arg)
{
	voip_calls_tapinfo_t *voip_tapinfo = (voip_calls_tapinfo_t *) arg;
	GList *listx;
	const char *sepa = "";

	if (!voip_tapinfo->redraw)
		return;

	printf("{\"tap\":\"%s\",\"type\":\"%s\"", "voip-calls", "voip-calls");
	printf(",\"completed\":%u", voip_tapinfo->completed_calls);
	printf(",\"rejected\":%u", voip_tapinfo->rejected_calls);
	printf(",\"startpkts\":%u", voip_tapinfo->start_packets);

	printf(",\"calls\":[");
	for (listx = g_queue_peek_nth_link(voip_tapinfo->callsinfos, 0); listx; listx = listx->next)
	{
		voip_calls_info_t *callinfo = (voip_calls_info_t *) listx->data;
		char *addr_str;

		addr_str = address_to_display(NULL, &(callinfo->initial_speaker));

		printf("%s{\"initial\":", sepa);
		json_puts_string(addr_str);

		printf(",\"start\":%.9f", nstime_to_sec(&callinfo->start_rel_ts));
		printf(",\"stop\":%.9f", nstime_to_sec(&callinfo->stop_rel_ts));
		printf(",\"pkts\":%u", callinfo->npackets);

		printf(",\"state\":");
		json_puts_string(voip_call_state_name[callinfo->call_state]);

		printf(",\"from\":");
		json_puts_string(callinfo->from_identity);

		printf(",\"to\":");
		json_puts_string(callinfo->to_identity);

		printf(",\"proto\":");
		if (callinfo->protocol == VOIP_COMMON && callinfo->protocol_name)
			json_puts_string(callinfo->protocol_name);
		else
			json_puts_string(voip_protocol_name[callinfo->protocol]);

		switch (callinfo->protocol)
		{
			case VOIP_ISUP:
			{
				isup_calls_info_t *isupinfo = (isup_calls_info_t *) callinfo->prot_info;

				printf(",\"isup_ni\":%d", isupinfo->ni);
				printf(",\"isup_opc\":%d", isupinfo->opc);
				printf(",\"isup_dpc\":%d", isupinfo->dpc);
				break;
			}

			case VOIP_H323:
			{
				h323_calls_info_t *h323info = (h323_calls_info_t *) callinfo->prot_info;
				int fast_start = FALSE;

				if (callinfo->call_state == VOIP_CALL_SETUP)
					fast_start = h323info->is_faststart_Setup;
				else if (h323info->is_faststart_Setup == TRUE && h323info->is_faststart_Proc == TRUE)
					fast_start = TRUE;

				printf(",\"h323_tunneling\":%s", (h323info->is_h245Tunneling == TRUE) ? "true" : "false");
				printf(",\"h323_fast_start\":%s", (fast_start == TRUE) ? "true" : "false");
				break;
			}

			case VOIP_COMMON:
			default:
				if (callinfo->call_comment)
				{
					printf(",\"comment\":");
					json_puts_string(callinfo->call_comment);
				}
				break;
		}

		/* based on GTK voip_calls_on_filter() */
		switch (callinfo->protocol)
		{
			case VOIP_SIP:
			{
				sip_calls_info_t *sipinfo = (sip_calls_info_t *) callinfo->prot_info;
				printf(",\"filter\":\"sip.Call-ID == \\\"%s\\\"\"", sipinfo->call_identifier);
				break;
			}

			default:
				break;
		}

		printf("}");
		sepa = ",";

		wmem_free(NULL, addr_str);
	}
	printf("]");

	printf("},");

	voip_tapinfo->redraw = 0; /* redrawn, XXX is it correct? it seems to, otherwise we will get this f. called multiple times (for example sccp, sua), but callsinfo didn't change  */
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
 *                  for type:voip-calls see sharkd_session_process_tap_voip_calls_cb()
 *                  for type:rtp-streams see sharkd_session_process_tap_rtp_cb()
 *
 *   (m) err   - error code
 */
static void
sharkd_session_process_tap(char *buf, const jsmntok_t *tokens, int count)
{
	void *taps_data[16];
	int taps_count = 0;
	int i;

	voip_calls_tapinfo_t voip_tapinfo;
	rtpstream_tapinfo_t rtp_tapinfo =
		{NULL, NULL, NULL, NULL, 0, NULL, 0, TAP_ANALYSE, NULL, NULL, NULL, FALSE};

	int voip_tapinfo_used = 0;

	for (i = 0; i < 16; i++)
	{
		char tapbuf[32];
		const char *tok_tap;

		tap_packet_cb tap_func = NULL;
		void *tap_data = NULL;
		const char *tap_filter = "";
		GString *tap_error = NULL;

		taps_data[i] = NULL;

		ws_snprintf(tapbuf, sizeof(tapbuf), "tap%d", i);
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
		else if (!strcmp(tok_tap, "voip-calls"))
		{
			/* based on Qt code */
			memset(&voip_tapinfo, 0, sizeof(voip_tapinfo));

			/* voip_tapinfo.tap_packet = tapPacket; */
			voip_tapinfo.tap_draw = sharkd_session_process_tap_voip_calls_cb;
			voip_tapinfo.tap_data = &voip_tapinfo;
			voip_tapinfo.callsinfos = g_queue_new();
			voip_tapinfo.h225_cstype = H225_OTHER;
			voip_tapinfo.fs_option = /* all_flows ? FLOW_ALL : */ FLOW_ONLY_INVITES; /* flow show option */
			voip_tapinfo.graph_analysis = sequence_analysis_info_new();
			voip_tapinfo.graph_analysis->type = SEQ_ANALYSIS_VOIP;

			voip_tapinfo.session = cfile.epan;

			voip_tapinfo_used = 1;
			voip_calls_init_all_taps(&voip_tapinfo);
		}
		else if (!strcmp(tok_tap, "rtp-streams"))
		{
			tap_error = register_tap_listener("rtp", &rtp_tapinfo, tap_filter, 0, rtpstream_reset_cb, rtpstream_packet, sharkd_session_process_tap_rtp_cb);

			tap_data = &rtp_tapinfo;
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

	if (voip_tapinfo_used)
	{
		// XXX possible memleaks
		voip_calls_reset_all_taps(&voip_tapinfo);
		voip_calls_remove_all_tap_listeners(&voip_tapinfo);

		g_queue_free(voip_tapinfo.callsinfos);
	}

	for (i = 0; i < 16; i++)
	{
		if (taps_data[i])
			remove_tap_listener(taps_data[i]);

		/* XXX, taps data memleaks */
	}
}

static void
sharkd_session_process_frame_cb_tree(proto_tree *tree, tvbuff_t **tvbs)
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

		if (finfo->ds_tvb && tvbs && tvbs[0] != finfo->ds_tvb)
		{
			int idx;

			for (idx = 1; tvbs[idx]; idx++)
			{
				if (tvbs[idx] == finfo->ds_tvb)
				{
					printf(",\"ds\":%d", idx);
					break;
				}
			}
		}

		if (finfo->start >= 0 && finfo->length > 0)
			printf(",\"h\":[%u,%u]", finfo->start, finfo->length);

		if (finfo->appendix_start >= 0 && finfo->appendix_length > 0)
			printf(",\"i\":[%u,%u]", finfo->appendix_start, finfo->appendix_length);

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
			if (finfo->tree_type != -1)
				printf(",\"e\":%d", finfo->tree_type);
			printf(",\"n\":");
			sharkd_session_process_frame_cb_tree((proto_tree *) node, tvbs);
		}

		printf("}");
		sepa = ",";
	}
	printf("]");
}

static void
sharkd_session_process_frame_cb(packet_info *pi, proto_tree *tree, struct epan_column_info *cinfo, const GSList *data_src, void *data)
{
	(void) pi;
	(void) data;

	printf("{");

	printf("\"err\":0");

	if (tree)
	{
		tvbuff_t **tvbs = NULL;

		printf(",\"tree\":");

		/* arrayize data src, to speedup searching for ds_tvb index */
		if (data_src && data_src->next /* only needed if there are more than one data source */)
		{
			guint count = g_slist_length((GSList *) data_src);
			guint i;

			tvbs = (tvbuff_t **) g_malloc((count + 1) * sizeof(*tvbs));

			for (i = 0; i < count; i++)
			{
				struct data_source *src = (struct data_source *) g_slist_nth_data((GSList *) data_src, i);

				tvbs[i] = get_data_source_tvb(src);
			}

			tvbs[count] = NULL;
		}

		sharkd_session_process_frame_cb_tree(tree, tvbs);

		g_free(tvbs);
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
		const char *ds_sepa = NULL;

		tvbuff_t *tvb;
		guint length;

		tvb = get_data_source_tvb(src);
		length = tvb_captured_length(tvb);

		printf(",\"bytes\":");
		if (length != 0)
		{
			const guchar *cp = tvb_get_ptr(tvb, 0, length);

			/* XXX pi.fd->flags.encoding */
			json_print_base64(cp, length);
		}
		else
		{
			json_print_base64("", 0);
		}

		data_src = data_src->next;
		if (data_src)
		{
			printf(",\"ds\":[");
			ds_sepa = "";
		}

		while (data_src)
		{
			src = (struct data_source *)data_src->data;

			{
				char *src_name = get_data_source_name(src);

				printf("%s{\"name\":", ds_sepa);
				json_puts_string(src_name);
				wmem_free(NULL, src_name);
			}

			tvb = get_data_source_tvb(src);
			length = tvb_captured_length(tvb);

			printf(",\"bytes\":");
			if (length != 0)
			{
				const guchar *cp = tvb_get_ptr(tvb, 0, length);

				/* XXX pi.fd->flags.encoding */
				json_print_base64(cp, length);
			}
			else
			{
				json_print_base64("", 0);
			}

			printf("}");
			ds_sepa = ",";

			data_src = data_src->next;
		}

		/* close ds, only if was opened */
		if (ds_sepa != NULL)
			printf("]");
	}

	printf("}\n");
}

/**
 * sharkd_session_process_intervals()
 *
 * Process intervals request - generate basic capture file statistics per requested interval.
 *
 * Input:
 *   (o) interval - interval time in ms, if not specified: 1000ms
 *   (o) filter   - filter for generating interval request
 *
 * Output object with attributes:
 *   (m) intervals - array of intervals, with indexes:
 *             [0] - index of interval,
 *             [1] - number of frames during interval,
 *             [2] - number of bytes during interval.
 *
 *   (m) last   - last interval number.
 *   (m) frames - total number of frames
 *   (m) bytes  - total number of bytes
 *
 * NOTE: If frames are not in order, there might be items with same interval index, or even negative one.
 */
static void
sharkd_session_process_intervals(char *buf, const jsmntok_t *tokens, int count)
{
	const char *tok_interval = json_find_attr(buf, tokens, count, "interval");
	const char *tok_filter = json_find_attr(buf, tokens, count, "filter");

	const guint8 *filter_data = NULL;

	struct
	{
		unsigned int frames;
		guint64 bytes;
	} stat, stat_total;

	nstime_t *start_ts = NULL;

	guint32 interval_ms = 1000; /* default: one per second */

	const char *sepa = "";
	unsigned int framenum;
	gint64 idx;
	gint64 max_idx = 0;

	if (tok_interval) {
		if (!ws_strtou32(tok_interval, NULL, &interval_ms) || interval_ms == 0) {
			fprintf(stderr, "Invalid interval parameter: %s.\n", tok_interval);
			return;
		}
	}

	if (tok_filter)
	{
		filter_data = sharkd_session_filter_data(tok_filter);
		if (!filter_data)
			return;
	}

	stat_total.frames = 0;
	stat_total.bytes  = 0;

	stat.frames = 0;
	stat.bytes  = 0;

	idx = 0;

	printf("{\"intervals\":[");

	for (framenum = 1; framenum <= cfile.count; framenum++)
	{
		frame_data *fdata = frame_data_sequence_find(cfile.frames, framenum);
		gint64 msec_rel;
		gint64 new_idx;

		if (start_ts == NULL)
			start_ts = &fdata->abs_ts;

		if (filter_data && !(filter_data[framenum / 8] & (1 << (framenum % 8))))
			continue;

		msec_rel = (fdata->abs_ts.secs - start_ts->secs) * (gint64) 1000 + (fdata->abs_ts.nsecs - start_ts->nsecs) / 1000000;
		new_idx  = msec_rel / interval_ms;

		if (idx != new_idx)
		{
			if (stat.frames != 0)
			{
				printf("%s[%" G_GINT64_FORMAT ",%u,%" G_GUINT64_FORMAT "]", sepa, idx, stat.frames, stat.bytes);
				sepa = ",";
			}

			idx = new_idx;
			if (idx > max_idx)
				max_idx = idx;

			stat.frames = 0;
			stat.bytes  = 0;
		}

		stat.frames += 1;
		stat.bytes  += fdata->pkt_len;

		stat_total.frames += 1;
		stat_total.bytes  += fdata->pkt_len;
	}

	if (stat.frames != 0)
	{
		printf("%s[%" G_GINT64_FORMAT ",%u,%" G_GUINT64_FORMAT "]", sepa, idx, stat.frames, stat.bytes);
		/* sepa = ","; */
	}

	printf("],\"last\":%" G_GINT64_FORMAT ",\"frames\":%u,\"bytes\":%" G_GUINT64_FORMAT "}\n", max_idx, stat_total.frames, stat_total.bytes);
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
 *                  e - subtree ett index
 *                  n - array of subtree nodes
 *                  h - two item array: (item start, item length)
 *                  i - two item array: (appendix start, appendix length)
 *                  p - [RESERVED] two item array: (protocol start, protocol length)
 *                  ds- data src index
 *
 *   (o) col   - array of column data
 *   (o) bytes - base64 of frame bytes
 *   (o) ds    - array of other data srcs
 */
static void
sharkd_session_process_frame(char *buf, const jsmntok_t *tokens, int count)
{
	const char *tok_frame = json_find_attr(buf, tokens, count, "frame");
	int tok_proto   = (json_find_attr(buf, tokens, count, "proto") != NULL);
	int tok_bytes   = (json_find_attr(buf, tokens, count, "bytes") != NULL);
	int tok_columns = (json_find_attr(buf, tokens, count, "columns") != NULL);

	guint32 framenum;

	if (!tok_frame || !ws_strtou32(tok_frame, NULL, &framenum) || framenum == 0)
		return;

	sharkd_dissect_request(framenum, &sharkd_session_process_frame_cb, tok_bytes, tok_columns, tok_proto, NULL);
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

struct sharkd_session_process_complete_pref_data
{
	const char *module;
	const char *pref;
	const char *sepa;
};

static guint
sharkd_session_process_complete_pref_cb(module_t *module, gpointer d)
{
	struct sharkd_session_process_complete_pref_data *data = (struct sharkd_session_process_complete_pref_data *) d;

	if (strncmp(data->pref, module->name, strlen(data->pref)) != 0)
		return 0;

	printf("%s{\"f\":\"%s\",\"d\":\"%s\"}", data->sepa, module->name, module->title);
	data->sepa = ",";

	return 0;
}

static guint
sharkd_session_process_complete_pref_option_cb(pref_t *pref, gpointer d)
{
	struct sharkd_session_process_complete_pref_data *data = (struct sharkd_session_process_complete_pref_data *) d;
	const char *pref_name = prefs_get_name(pref);
	const char *pref_title = prefs_get_title(pref);

	if (strncmp(data->pref, pref_name, strlen(data->pref)) != 0)
		return 0;

	printf("%s{\"f\":\"%s.%s\",\"d\":\"%s\"}", data->sepa, data->module, pref_name, pref_title);
	data->sepa = ",";

	return 0; /* continue */
}

/**
 * sharkd_session_process_complete()
 *
 * Process complete request
 *
 * Input:
 *   (o) field - field to be completed
 *   (o) pref  - preference to be completed
 *
 * Output object with attributes:
 *   (m) err - always 0
 *   (o) field - array of object with attributes:
 *                  (m) f - field text
 *                  (o) t - field type (FT_ number)
 *                  (o) n - field name
 *   (o) pref  - array of object with attributes:
 *                  (m) f - pref name
 *                  (o) d - pref description
 */
static int
sharkd_session_process_complete(char *buf, const jsmntok_t *tokens, int count)
{
	const char *tok_field = json_find_attr(buf, tokens, count, "field");
	const char *tok_pref  = json_find_attr(buf, tokens, count, "pref");

	printf("{\"err\":0");
	if (tok_field != NULL && tok_field[0])
	{
		const size_t filter_length = strlen(tok_field);
		const int filter_with_dot = !!strchr(tok_field, '.');

		void *proto_cookie;
		void *field_cookie;
		int proto_id;
		const char *sepa = "";

		printf(",\"field\":[");

		for (proto_id = proto_get_first_protocol(&proto_cookie); proto_id != -1; proto_id = proto_get_next_protocol(&proto_cookie))
		{
			protocol_t *protocol = find_protocol_by_id(proto_id);
			const char *protocol_filter;
			const char *protocol_name;
			header_field_info *hfinfo;

			if (!proto_is_protocol_enabled(protocol))
				continue;

			protocol_name   = proto_get_protocol_long_name(protocol);
			protocol_filter = proto_get_protocol_filter_name(proto_id);

			if (strlen(protocol_filter) >= filter_length && !g_ascii_strncasecmp(tok_field, protocol_filter, filter_length))
			{
				printf("%s{", sepa);
				{
					printf("\"f\":");
					json_puts_string(protocol_filter);
					printf(",\"t\":%d", FT_PROTOCOL);
					printf(",\"n\":");
					json_puts_string(protocol_name);
				}
				printf("}");
				sepa = ",";
			}

			if (!filter_with_dot)
				continue;

			for (hfinfo = proto_get_first_protocol_field(proto_id, &field_cookie); hfinfo != NULL; hfinfo = proto_get_next_protocol_field(proto_id, &field_cookie))
			{
				if (hfinfo->same_name_prev_id != -1) /* ignore duplicate names */
					continue;

				if (strlen(hfinfo->abbrev) >= filter_length && !g_ascii_strncasecmp(tok_field, hfinfo->abbrev, filter_length))
				{
					printf("%s{", sepa);
					{
						printf("\"f\":");
						json_puts_string(hfinfo->abbrev);

						/* XXX, skip displaying name, if there are multiple (to not confuse user) */
						if (hfinfo->same_name_next == NULL)
						{
							printf(",\"t\":%d", hfinfo->type);
							printf(",\"n\":");
							json_puts_string(hfinfo->name);
						}
					}
					printf("}");
					sepa = ",";
				}
			}
		}

		printf("]");
	}

	if (tok_pref != NULL && tok_pref[0])
	{
		struct sharkd_session_process_complete_pref_data data;
		char *dot_sepa;

		data.module = tok_pref;
		data.pref = tok_pref;
		data.sepa = "";

		printf(",\"pref\":[");

		if ((dot_sepa = strchr(tok_pref, '.')))
		{
			module_t *pref_mod;

			*dot_sepa = '\0'; /* XXX, C abuse: discarding-const */
			data.pref = dot_sepa + 1;

			pref_mod = prefs_find_module(data.module);
			if (pref_mod)
				prefs_pref_foreach(pref_mod, sharkd_session_process_complete_pref_option_cb, &data);

			*dot_sepa = '.';
		}
		else
		{
			prefs_modules_foreach(sharkd_session_process_complete_pref_cb, &data);
		}

		printf("]");
	}


	printf("}\n");
	return 0;
}

/**
 * sharkd_session_process_setconf()
 *
 * Process setconf request
 *
 * Input:
 *   (m) name  - preference name
 *   (m) value - preference value
 *
 * Output object with attributes:
 *   (m) err   - error code: 0 succeed
 */
static void
sharkd_session_process_setconf(char *buf, const jsmntok_t *tokens, int count)
{
	const char *tok_name = json_find_attr(buf, tokens, count, "name");
	const char *tok_value = json_find_attr(buf, tokens, count, "value");
	char pref[4096];

	prefs_set_pref_e ret;

	if (!tok_name || tok_name[0] == '\0' || !tok_value)
		return;

	ws_snprintf(pref, sizeof(pref), "%s:%s", tok_name, tok_value);

	ret = prefs_set_pref(pref);
	printf("{\"err\":%d}\n", ret);
}

struct sharkd_session_process_dumpconf_data
{
	module_t *module;
	const char *sepa;
};

static guint
sharkd_session_process_dumpconf_cb(pref_t *pref, gpointer d)
{
	struct sharkd_session_process_dumpconf_data *data = (struct sharkd_session_process_dumpconf_data *) d;
	const char *pref_name = prefs_get_name(pref);

	printf("%s\"%s.%s\":{", data->sepa, data->module->name, pref_name);

	switch (prefs_get_type(pref))
	{
		case PREF_UINT:
		case PREF_DECODE_AS_UINT:
			printf("\"u\":%u", prefs_get_uint_value_real(pref, pref_current));
			if (prefs_get_uint_base(pref) != 10)
				printf(",\"ub\":%d", prefs_get_uint_base(pref));
			break;

		case PREF_BOOL:
			printf("\"b\":%s", prefs_get_bool_value(pref, pref_current) ? "1" : "0");
			break;

		case PREF_STRING:
			printf("\"s\":");
			json_puts_string(prefs_get_string_value(pref, pref_current));
			break;

		case PREF_ENUM:
		{
			const enum_val_t *enums;
			const char *enum_sepa = "";

			printf("\"e\":[");
			for (enums = prefs_get_enumvals(pref); enums->name; enums++)
			{
				printf("%s{\"v\":%d", enum_sepa, enums->value);

				if (enums->value == prefs_get_enum_value(pref, pref_current))
					printf(",\"s\":1");

				printf(",\"d\":");
				json_puts_string(enums->description);

				printf("}");
				enum_sepa = ",";
			}
			printf("]");
			break;
		}

		case PREF_RANGE:
		case PREF_DECODE_AS_RANGE:
		{
			char *range_str = range_convert_range(NULL, prefs_get_range_value_real(pref, pref_current));
			printf("\"r\":\"%s\"", range_str);
			wmem_free(NULL, range_str);
			break;
		}

		case PREF_UAT:
		{
			uat_t *uat = prefs_get_uat_value(pref);
			guint idx;

			printf("\"t\":[");
			for (idx = 0; idx < uat->raw_data->len; idx++)
			{
				void *rec = UAT_INDEX_PTR(uat, idx);
				guint colnum;

				if (idx)
					printf(",");

				printf("[");
				for (colnum = 0; colnum < uat->ncols; colnum++)
				{
					char *str = uat_strfld(rec, &(uat->fields[colnum]));

					if (colnum)
						printf(",");

					json_puts_string(str);
					g_free(str);
				}

				printf("]");
			}

			printf("]");
			break;
		}

		case PREF_COLOR:
		case PREF_CUSTOM:
		case PREF_STATIC_TEXT:
		case PREF_OBSOLETE:
			/* TODO */
			break;
	}

#if 0
	printf(",\"t\":");
	json_puts_string(pref->title);
#endif

	printf("}");
	data->sepa = ",";

	return 0; /* continue */
}

static guint
sharkd_session_process_dumpconf_mod_cb(module_t *module, gpointer d)
{
	struct sharkd_session_process_dumpconf_data *data = (struct sharkd_session_process_dumpconf_data *) d;

	data->module = module;
	prefs_pref_foreach(module, sharkd_session_process_dumpconf_cb, data);

	return 0;
}

/**
 * sharkd_session_process_dumpconf()
 *
 * Process dumpconf request
 *
 * Input:
 *   (o) pref - module, or preference, NULL for all
 *
 * Output object with attributes:
 *   (o) prefs   - object with module preferences
 *                  (m) [KEY] - preference name
 *                  (o) u - preference value (only for PREF_UINT)
 *                  (o) ub - preference value suggested base for display (only for PREF_UINT) and if different than 10
 *                  (o) b - preference value (only for PREF_BOOL) (1 true, 0 false)
 *                  (o) s - preference value (only for PREF_STRING)
 *                  (o) e - preference possible values (only for PREF_ENUM)
 *                  (o) r - preference value (only for PREF_RANGE)
 *                  (o) t - preference value (only for PREF_UAT)
 */
static void
sharkd_session_process_dumpconf(char *buf, const jsmntok_t *tokens, int count)
{
	const char *tok_pref = json_find_attr(buf, tokens, count, "pref");
	module_t *pref_mod;
	char *dot_sepa;

	if (!tok_pref)
	{
		struct sharkd_session_process_dumpconf_data data;

		data.module = NULL;
		data.sepa = "";

		printf("{\"prefs\":{");
		prefs_modules_foreach(sharkd_session_process_dumpconf_mod_cb, &data);
		printf("}}\n");
		return;
	}

	if ((dot_sepa = strchr(tok_pref, '.')))
	{
		pref_t *pref = NULL;

		*dot_sepa = '\0'; /* XXX, C abuse: discarding-const */
		pref_mod = prefs_find_module(tok_pref);
		if (pref_mod)
			pref = prefs_find_preference(pref_mod, dot_sepa + 1);
		*dot_sepa = '.';

		if (pref)
		{
			struct sharkd_session_process_dumpconf_data data;

			data.module = pref_mod;
			data.sepa = "";

			printf("{\"prefs\":{");
			sharkd_session_process_dumpconf_cb(pref, &data);
			printf("}}\n");
		}

		return;
	}

	pref_mod = prefs_find_module(tok_pref);
	if (pref_mod)
	{
		struct sharkd_session_process_dumpconf_data data;

		data.module = pref_mod;
		data.sepa = "";

		printf("{\"prefs\":{");
		prefs_pref_foreach(pref_mod, sharkd_session_process_dumpconf_cb, &data);
		printf("}}\n");
    }
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

		json_unescape_str(&buf[tokens[i + 0].start]);
		json_unescape_str(&buf[tokens[i + 1].start]);
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
		else if (!strcmp(tok_req, "analyse"))
			sharkd_session_process_analyse();
		else if (!strcmp(tok_req, "info"))
			sharkd_session_process_info();
		else if (!strcmp(tok_req, "check"))
			sharkd_session_process_check(buf, tokens, count);
		else if (!strcmp(tok_req, "complete"))
			sharkd_session_process_complete(buf, tokens, count);
		else if (!strcmp(tok_req, "frames"))
			sharkd_session_process_frames(buf, tokens, count);
		else if (!strcmp(tok_req, "tap"))
			sharkd_session_process_tap(buf, tokens, count);
		else if (!strcmp(tok_req, "intervals"))
			sharkd_session_process_intervals(buf, tokens, count);
		else if (!strcmp(tok_req, "frame"))
			sharkd_session_process_frame(buf, tokens, count);
		else if (!strcmp(tok_req, "setconf"))
			sharkd_session_process_setconf(buf, tokens, count);
		else if (!strcmp(tok_req, "dumpconf"))
			sharkd_session_process_dumpconf(buf, tokens, count);
		else if (!strcmp(tok_req, "bye"))
			exit(0);
		else
			fprintf(stderr, "::: req = %s\n", tok_req);

		/* reply for every command are 0+ lines of JSON reply (outputed above), finished by empty new line */
		printf("\n");

		/*
		 * We do an explicit fflush after every line, because
		 * we want output to be written to the socket as soon
		 * as the line is complete.
		 *
		 * The stream is fully-buffered by default, so it's
		 * only flushed when the buffer fills or the FILE *
		 * is closed.  On UN*X, we could set it to be line
		 * buffered, but the MSVC standard I/O routines don't
		 * support line buffering - they only support *byte*
		 * buffering, doing a write for every byte written,
		 * which is too inefficient, and full buffering,
		 * which is what you get if you request line buffering.
		 */
		fflush(stdout);
	}
}

int
sharkd_session_main(void)
{
	char buf[16 * 1024];
	jsmntok_t *tokens = NULL;
	int tokens_max = -1;

	fprintf(stderr, "Hello in child!\n");

	while (fgets(buf, sizeof(buf), stdin))
	{
		/* every command is line seperated JSON */
		int ret;

		ret = wsjsmn_parse(buf, NULL, 0);
		if (ret < 0)
		{
			fprintf(stderr, "invalid JSON -> closing\n");
			return 1;
		}

		/* fprintf(stderr, "JSON: %d tokens\n", ret); */
		ret += 1;

		if (tokens == NULL || tokens_max < ret)
		{
			tokens_max = ret;
			tokens = (jsmntok_t *) g_realloc(tokens, sizeof(jsmntok_t) * tokens_max);
		}

		memset(tokens, 0, ret * sizeof(jsmntok_t));

		ret = wsjsmn_parse(buf, tokens, ret);
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

/*
 * Editor modelines  -  http://www.wireshark.org/tools/modelines.html
 *
 * Local variables:
 * c-basic-offset: 8
 * tab-width: 8
 * indent-tabs-mode: t
 * End:
 *
 * vi: set shiftwidth=8 tabstop=8 noexpandtab:
 * :indentSize=8:tabSize=8:noTabs=false:
 */
