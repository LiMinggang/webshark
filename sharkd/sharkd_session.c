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
