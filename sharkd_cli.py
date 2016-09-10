#!/bin/python3

# Copyright (C) 2016 Jakub Zawadzki
#
# This program is free software: you can redistribute it and/or  modify
# it under the terms of the GNU Affero General Public License, version 3,
# as published by the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

import sys
import socket
import json
import threading

class SharkdClient:
	def __init__(self, host, port):
		self.mutex = threading.Lock()
		self.fd = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
		self.fd.connect((host, port))

	def __init__(self, path):
		self.mutex = threading.Lock()
		self.fd = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
		self.fd.connect(path)

	def _send_raw(self, data):
		total = 0
		while total < len(data):
			sent = self.fd.send(data[total:])
			if sent == 0:
				raise RuntimeError("socket connection broken")
			total += sent

	def _send_str(self, s):
		self._send_raw(s.encode())

	def _recv_line(self):
		chunks = []
		while True:
			chunk = self.fd.recv(1)
			if len(chunk) == 0:
				break
			if isinstance(chunk[0], int) and chunk[0] == 10:   # python3
				break
			if isinstance(chunk[0], str) and chunk[0] == '\n': # python2
				break
			chunks.append(chunk)
		return b''.join(chunks)

	def send(self, d):
		js = json.dumps(d)
		self._send_str(js + "\n")

	def recv(self):
		return self._recv_line().decode('utf8')

	# send request, return every line
	def send_req_gen(self, d):
		try:
			self.mutex.acquire()
			self.send(d)
			while True:
				s = self.recv()
				if len(s) == 0:
					break
				yield s
		finally:
			self.mutex.release()

	# send request, return last line
	def send_req(self, d):
		last_line = ""
		for last_line in self.send_req_gen(d):
			pass
		return last_line


if __name__ == '__main__':
	filename = sys.argv[1]

	cli = SharkdClient('/tmp/sharkd.sock')

	for l in cli.send_req_gen(dict(req='load', file=filename)):
		print("Loading: " + l)

	cli.send_req(dict(req='bye'))
