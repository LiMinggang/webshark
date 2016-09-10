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
		self.buf = None
		self.fd = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
		self.fd.connect((host, port))

	def __init__(self, path):
		self.mutex = threading.Lock()
		self.buf = None
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

	def _recv_bytes(self, dest):
		if self.buf == None:
			self.buf = self.fd.recv(4096)
			self.bufpos = 0
			if len(self.buf) == 0:
				self.buf = None
				return None

		start = self.bufpos

		if isinstance(self.buf[0], int):   # python3
			pos = self.buf.find(10, start)
		else:                              # python2
			pos = self.buf.find('\n', start)

		if pos != -1:
			nl = True
			pos = pos + 1
		else:
			nl = False
			pos = len(self.buf)

		if nl:
			chunk = self.buf[start:pos-1]
		else:
			chunk = self.buf[start:]

		dest.extend(chunk)

		self.bufpos = pos

		if len(self.buf) == self.bufpos:
			self.buf = None

		return nl

	def _recv_line(self):
		chunks = []
		while True:
			nl = self._recv_bytes(chunks)
			if nl == None:
				break

			if nl == True:
				break

		if len(chunks) and isinstance(chunks[0], int):   # python3
			return bytes(chunks)

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
