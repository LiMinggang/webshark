/* sharkd_daemon.c
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
#include <signal.h>
#include <unistd.h>

#include <sys/socket.h>
#include <sys/un.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>

static int _server_fd = -1;

int sharkd_session_main(void);

static int
socket_init(char *path)
{
	int fd = -1;

	if (!strncmp(path, "unix:", 5))
	{
		struct sockaddr_un s_un;

		path += 5;

		fd = socket(AF_UNIX, SOCK_STREAM, 0);
		if (fd == -1)
			return -1;

		s_un.sun_family = AF_UNIX;
		strcpy(s_un.sun_path, path);

		if (bind(fd, (struct sockaddr *) &s_un, sizeof(struct sockaddr_un)))
		{
			close(fd);
			return -1;
		}

	}
	else if (!strncmp(path, "tcp:", 4))
	{
		struct sockaddr_in s_in;
		int one = 1;
		char *port_sep;

		path += 4;

		fd = socket(AF_INET, SOCK_STREAM, 0);
		if (fd == -1)
			return -1;

		port_sep = strchr(path, ':');
		if (!port_sep)
			return -1;

		*port_sep = '\0';
		s_in.sin_family = AF_INET;
		s_in.sin_addr.s_addr = inet_addr(path);
		s_in.sin_port = htons(atoi(port_sep + 1));
		*port_sep = ':';

		setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

		if (bind(fd, (struct sockaddr *) &s_in, sizeof(struct sockaddr_in)))
		{
			close(fd);
			return -1;
		}
	}
	else
	{
		return -1;
	}

	if (listen(fd, SOMAXCONN))
	{
		close(fd);
		return -1;
	}

	return fd;
}

int
sharkd_init(int argc, char **argv)
{
	// char server_sock[] = "unix:/tmp/sharkd.sock";
	// char server_sock[] = "tcp:127.0.0.1:4446";

	int fd;

	if (argc != 2)
	{
		fprintf(stderr, "usage: %s <socket>\n", argv[0]);
		return -1;
	}

	signal(SIGCHLD, SIG_IGN);

	fd = socket_init(argv[1]);

	if (fd == -1)
		return -1;

	/* all good - try to daemonize */
	if (fork())
	{
		/* parent */
		exit(0);
	}

	_server_fd = fd;
	return 0;
}

int
sharkd_loop(void)
{
	while (1)
	{
		int fd;

		fd = accept(_server_fd, NULL, NULL);

		/* wireshark is not ready for handling multiple capture files in single process, so fork(), and handle it in seperate process */
		if (!fork())
		{
			/* redirect stdin, stdout to socket */
			dup2(fd, 0);
			dup2(fd, 1);
			close(fd);

			exit(sharkd_session_main());
		}

		close(fd);
	}

	return 0;
}
