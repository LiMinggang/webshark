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

from .sharkd_cli import SharkdClient

captures = dict()
lock = threading.Lock()

cap_dir_default = os.getenv("HOME") + "/webshark_captures"
cap_dir = getattr(settings, "SHARKD_CAP_DIR", cap_dir_default) + "/"

def index(request):
    context = { }
    return render(request, 'webshark/index.html', context)

def sharkd_instance(cap):
    shark = captures.get(cap, None)

    if shark == None:
        try:
            shark = SharkdClient('@sharkd-socket')
        except ConnectionRefusedError:
            subprocess.call([ "sharkd", "unix:@sharkd-socket"])
            raise

        captures[cap] = shark
        if cap != '':
            shark.send_req(dict(req='load', file=cap))
    return shark

def json_handle_request(req):
    cap_file = req.GET.get('capture', '')
    if '..' in cap_file:
        return json.dumps(dict(err=1, errstr="Nope"))

    if cap_file != '':
        cap = cap_dir + cap_file
        if os.path.isfile(cap) == False:
            return json.dumps(dict(err=1, errstr="No such capture file"))
    else:
        cap = cap_file

    try:
        lock.acquire()
        shark = sharkd_instance(cap)
    finally:
        lock.release()

    try:
        ret = shark.send_req(req.GET.dict())
    except BrokenPipeError:
        try:
            lock.acquire()
            captures[cap] = None
        finally:
            lock.release()
        ret = None

    return ret

def json_req(request):
    # js = json.dumps(json_handle_request(request))
    js = json_handle_request(request)
    return HttpResponse(js, content_type="application/json")
