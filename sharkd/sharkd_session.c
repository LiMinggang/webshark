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
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#include <glib.h>

#include <wsutil/jsmn.h>

#include <file.h>
#include <epan/exceptions.h>
#include <wiretap/wtap.h>

cf_status_t sharkd_cf_open(const char *fname, unsigned int type, gboolean is_tempfile, int *err);
int sharkd_load_cap_file(void);
int sharkd_dissect_columns(int framenum, column_info *cinfo, gboolean dissect_color);
int sharkd_dissect_request(int framenum, void *cb, int dissect_bytes, int dissect_columns, int dissect_tree);

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

static void
sharkd_session_process_status(void)
{
	extern capture_file cfile;
	int i;

	printf("{\"frames\":%d, \"columns\":[", cfile.count);
	for (i = 0; i < cfile.cinfo.num_cols; i++)
	{
		const col_item_t *col_item = &cfile.cinfo.columns[i];

		printf("%s\"%s\"", (i) ? "," : "", col_item->col_title);
	}
	printf("]");

	printf("}\n");
}


static void
sharkd_session_process_frames(void)
{
	extern capture_file cfile;

	const char *frame_sepa = "";
	unsigned int framenum;
	int col;

	printf("[");
	for (framenum = 1; framenum <= cfile.count; framenum++)
	{
		sharkd_dissect_columns(framenum, &cfile.cinfo, TRUE);

		printf("%s{\"c\":[", frame_sepa);
		for (col = 0; col < cfile.cinfo.num_cols; ++col)
		{
			const col_item_t *col_item = &cfile.cinfo.columns[col];

			if (col)
				printf(",");

			json_puts_string(col_item->col_data);
		}
		printf("],\"num\":%u}", framenum);

		frame_sepa = ",";
	}
	printf("]\n");
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

		printf("%s", sepa);

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

		sepa = ",";

		if (((proto_tree *) node)->first_child) {
			printf(",");
			sharkd_session_process_frame_cb_tree((proto_tree *) node);
		}
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

		printf(",\"bytes\":[");

		tvb = get_data_source_tvb(src);

		length = tvb_captured_length(tvb);
		if (length != 0)
		{
			const guchar *cp = tvb_get_ptr(tvb, 0, length);
			size_t i;

			/* XXX pi.fd->flags.encoding */
			for (i = 0; i < length; i++)
				printf("%s%d", (i) ? "," : "", cp[i]);
		}
		printf("]");
	}

	printf("}\n");
}

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
		else if (!strcmp(tok_req, "frames"))
			sharkd_session_process_frames();
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
