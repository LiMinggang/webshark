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

from django.http import HttpResponse
from django.shortcuts import render
from django.conf import settings
import json

import sys
import os
import threading
import socket
import json
import subprocess

from .models import Capture, CaptureSettings
from .sharkd_cli import SharkdClient

captures = dict()
lock = threading.Lock()

cap_dir_default = os.getenv("HOME") + "/webshark_captures"
cap_dir = getattr(settings, "SHARKD_CAP_DIR", cap_dir_default) + "/"

def index(request):
    context = { }
    return render(request, 'webshark/index.html', context)

def sharkd_instance(cap_file):
    shark = captures.get(cap_file, None)

    if shark == None:
        try:
            shark = SharkdClient('@sharkd-socket')
        except ConnectionRefusedError:
            subprocess.call([ "sharkd", "unix:@sharkd-socket"])
            raise

        captures[cap_file] = shark
        if cap_file != '':
            settings = CaptureSettings.objects.filter(capture__filename=cap_file).all()
            for s in settings:
                shark.send_req(dict(req='setconf', name=s.var, value=s.value))

            # shark.send_req(dict(req='setconf', name='uat:geoip_db_paths', value='"/usr/share/GeoIP"'))
            cap = cap_dir + cap_file
            shark.send_req(dict(req='load', file=cap))

    return shark

def sharkd_file_list_refresh_db():
    for root, dirs, files in os.walk(cap_dir):
        for name in files:
            full_filename = os.path.join(root, name)
            filename = os.path.relpath(full_filename, cap_dir)

            try:
                obj = Capture.objects.get(filename=filename)
            except Capture.DoesNotExist:

                shark = SharkdClient('@sharkd-socket')
                shark.send_req(dict(req='load', file=full_filename))
                analysis = shark.send_req(dict(req='analyse'))
                shark.send_req(dict(req='bye'))

                obj = Capture(filename=filename, description='', analysis=analysis)
                obj.save()

    return ''

def sharkd_file_list():
    result = list()
    for root, dirs, files in os.walk(cap_dir):
        for name in files:
            full_filename = os.path.join(root, name)
            filename = os.path.relpath(full_filename, cap_dir)

            cap = dict()
            cap['name'] = filename
            cap['size'] = os.stat(full_filename).st_size
            if captures.get(filename, False):
                cap['status'] = dict(online=True) ## TODO: CPU time, memory usage, ...

            try:
                obj = Capture.objects.get(filename=filename)
                cap['analysis'] = json.loads(obj.analysis)
                cap['desc'] = obj.description
            except Capture.DoesNotExist:
                pass

            result.append(cap)

    return result

def json_handle_request(request):
    cap_file = request.GET.get('capture', '')
    req      = request.GET.get('req', '')

    if req == '':
        return json.dumps(dict(err=1, errstr="No request"))

    if req == 'refreshdb':
        return sharkd_file_list_refresh_db()

    if req == 'files':
        return json.dumps(dict(files=sharkd_file_list()))

    # internal request
    if req == 'load':
        return json.dumps(dict(err=1, errstr="Nope"))

    if '..' in cap_file:
        return json.dumps(dict(err=1, errstr="Nope"))

    if cap_file != '':
        if os.path.isfile(cap_dir + cap_file) == False:
            return json.dumps(dict(err=1, errstr="No such capture file"))

    try:
        lock.acquire()
        shark = sharkd_instance(cap_file)
    finally:
        lock.release()

    try:
        ret = shark.send_req(request.GET.dict())
    except BrokenPipeError:
        try:
            lock.acquire()
            captures[cap_file] = None
        finally:
            lock.release()
        ret = None

    return ret

def json_req(request):
    # js = json.dumps(json_handle_request(request))
    js = json_handle_request(request)
    return HttpResponse(js, content_type="application/json")
