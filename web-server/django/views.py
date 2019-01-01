#!/bin/python3

# Copyright (C) 2016 Jakub Zawadzki
#
# This program is free software; you can redistribute it and/or
# modify it under the terms of the GNU General Public License
# as published by the Free Software Foundation; either version 2
# of the License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; if not, write to the Free Software
# Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.

from django.http import HttpResponse
from django.shortcuts import render
from django.conf import settings
from django.views.decorators.csrf import csrf_exempt
from django.core.exceptions import PermissionDenied

import sys
import os
import time
import threading
import socket
import json
import base64
import subprocess
import tempfile

from .forms import UploadFileForm
from .models import Capture, CaptureSettings, CaptureComments
from .sharkd_cli import SharkdClient

captures = dict()
lock = threading.Lock()

cap_dir_default = os.getenv("HOME") + "/webshark_captures"
cap_dir = getattr(settings, "SHARKD_CAP_DIR", cap_dir_default) + "/"
cap_upload_tmpdir = getattr(settings, "SHARKD_UPLOAD_TMPDIR", cap_dir + '../upload') + "/"

def index(request):
    from django.shortcuts import redirect
    return redirect('/static/webshark/index.html')

sharkd_json_sepa = (',', ':')
def sharkd_json_dump(obj):
    return json.dumps(obj, check_circular=False, separators=sharkd_json_sepa)

def sharkd_check_permission(cap_obj, user):
    if cap_obj.owner:
        return (cap_obj.owner == user)
    return True

def sharkd_check_permission_exception(cap_obj, user):
    if not sharkd_check_permission(cap_obj, user):
        raise PermissionDenied

def sharkd_instance(cap_file, user):
    capture = captures.get(cap_file, None)

    if capture == None:
        cap_obj = None

        if cap_file != '':
            try:
                cap_obj = Capture.objects.filter(filename=cap_file).get()
                sharkd_check_permission_exception(cap_obj, user)
            except Capture.DoesNotExist:
                pass

        try:
            shark = SharkdClient('@sharkd-socket')
        except ConnectionRefusedError:
            subprocess.call([ "sharkd", "unix:@sharkd-socket"])
            raise

        if cap_file != '':
            settings = CaptureSettings.objects.filter(capture=cap_obj).all()
            comments = CaptureComments.objects.filter(capture=cap_obj).all()

            for s in settings:
                shark.send_req(dict(req='setconf', name=s.var, value=s.value))

            # shark.send_req(dict(req='setconf', name='uat:maxmind_db_paths', value='"/var/lib/GeoIP"'))
            cap = cap_dir + cap_file
            shark.send_req(dict(req='load', file=cap))

            for c in comments:
                commenter = dict(req='setcomment', frame=c.framenum)
                if c.comment != '':
                    commenter['comment'] = c.comment
                shark.send_req(commenter)

        capture = dict(sharkd=shark, obj=cap_obj)
        captures[cap_file] = capture

    elif capture['obj']:
        sharkd_check_permission_exception(capture['obj'], user)

    return capture['sharkd']

def sharkd_capture_get_or_create(filename):
    try:
        obj = Capture.objects.get(filename=filename)
    except Capture.DoesNotExist:
        full_filename = cap_dir + filename

        shark = SharkdClient('@sharkd-socket')
        shark.send_req(dict(req='load', file=full_filename))
        analysis = shark.send_req(dict(req='analyse'))
        shark.send_req(dict(req='bye'))

        obj = Capture(filename=filename, description='', analysis=analysis, owner=None)
        obj.save()
    return obj

def sharkd_file_list_refresh_db():
    for root, dirs, files in os.walk(cap_dir):
        for name in files:
            full_filename = os.path.join(root, name)
            filename = os.path.relpath(full_filename, cap_dir)

            sharkd_capture_get_or_create(filename)

    return ''

def sharkd_file_list_chunk(result, filenames, user):
    objs = dict( (item.filename, item) for item in Capture.objects.filter(filename__in=filenames) )

    for filename in filenames:
        full_filename = cap_dir + filename

        cap = dict()

        obj = objs.get(filename, None)
        if obj:
            if not sharkd_check_permission(obj, user):
                continue
            cap['analysis'] = json.loads(obj.analysis)
            cap['desc'] = obj.description

        cap['name'] = os.path.basename(filename)
        if os.path.isdir(full_filename):
            cap['dir'] = True
        else:
            cap['size'] = os.stat(full_filename).st_size
            if captures.get(filename, False):
                cap['status'] = dict(online=True) ## TODO: CPU time, memory usage, ...

        result.append(cap)

def sharkd_file_list(directory, user):
    result = list()
    filenames = list()

    thisdir = cap_dir + directory
    names = os.listdir(thisdir)
    if names:
        for name in names:
            full_filename = os.path.join(thisdir, name)
            filename = os.path.relpath(full_filename, cap_dir)
            filenames.append(filename)

            if len(filenames) > 1000:
                sharkd_file_list_chunk(result, filenames, user)
                filenames = list()

    if len(filenames) > 0:
        sharkd_file_list_chunk(result, filenames, user)

    reldir = os.path.relpath(thisdir, cap_dir)

    return dict(files=result, pwd=reldir)

def json_handle_request(request):
    cap_file = request.GET.get('capture', '')
    req      = request.GET.get('req', '')

    if req == '':
        return sharkd_json_dump(dict(err=1, errstr="No request"))

    if req == 'refreshdb':
        return sharkd_file_list_refresh_db()

    if req == 'files':
        directory = request.GET.get('dir', '')
        if '..' in directory:
            return sharkd_json_dump(dict(err=1, errstr="Nope"))
        return sharkd_json_dump(sharkd_file_list(directory, request.user))

    # internal requests
    if req == 'load':
        return sharkd_json_dump(dict(err=1, errstr="Nope"))
    if req == 'setconf':
        return sharkd_json_dump(dict(err=1, errstr="Nope"))

    if '..' in cap_file:
        return sharkd_json_dump(dict(err=1, errstr="Nope"))

    if cap_file != '':
        if os.path.isfile(cap_dir + cap_file) == False:
            return sharkd_json_dump(dict(err=1, errstr="No such capture file"))
        cap_file = os.path.relpath(cap_dir + cap_file, cap_dir)

    if req == 'setcomment':
        cap_obj = sharkd_capture_get_or_create(cap_file)
        sharkd_check_permission_exception(cap_obj, request.user)

        frame = request.GET.get("frame")
        comment = request.GET.get("comment", '')

        obj, created = CaptureComments.objects.update_or_create(capture=cap_obj, framenum=frame, defaults={'comment': comment})
        obj.save()
        # TODO, send notification to other clients, when ready...

    # TODO, download request don't need sharkd instance, but sharkd_instance() also checks permissions.
    try:
        lock.acquire()
        shark = sharkd_instance(cap_file, request.user)
    finally:
        lock.release()

    if req == 'download':
        ## FIXME
        if request.GET.get('token', '') == 'self':
            mime = "application/octet-stream"
            filename = cap_file
            data = open(cap_dir + cap_file, "rb").read()

            response = HttpResponse(content_type=mime)
            response['Content-Disposition'] = 'attachment; filename="' + filename + '"'

            response.write(data)
            return response

    try:
        ret = shark.send_req(request.GET.dict())
    except BrokenPipeError:
        try:
            lock.acquire()
            captures[cap_file] = None
        finally:
            lock.release()
        ret = None

    if req == 'info' and request.user.is_authenticated():
        js = json.loads(ret)
        js['user'] = request.user.get_username()
        ret = sharkd_json_dump(js)

    if req == 'download':
        ## FIXME
        js = json.loads(ret)
        mime = js['mime']
        filename = js['file']
        data = base64.b64decode(js['data'])

        response = HttpResponse(content_type=mime)
        response['Content-Disposition'] = 'attachment; filename="' + filename + '"'

        response.write(data)
        return response

    return ret

def json_req(request):
    # js = sharkd_json_dump(json_handle_request(request))
    js = json_handle_request(request)

    ## FIXME
    if isinstance(js, HttpResponse):
        return js

    return HttpResponse(js, content_type="application/json")

def handle_uploaded_file(f, owner):
    if f.size > 10 * 1024 * 1024:
        return

    fd, tmp_name = tempfile.mkstemp(dir=cap_upload_tmpdir)

    with os.fdopen(fd, 'wb') as destination:
        for chunk in f.chunks():
            destination.write(chunk)

    try:
        shark = SharkdClient('@sharkd-socket')
        shark.send_req(dict(req='load', file=tmp_name))
        analysis = shark.send_req(dict(req='analyse'))
        shark.send_req(dict(req='bye'))

        js = dict()
        js['size'] = os.stat(tmp_name).st_size
        js['analysis'] = json.loads(analysis)

        # move only if frames > 0
        if js['analysis']['frames'] > 0:
            desc = 'File uploaded on ' + time.asctime() + '. Original filename: ' + f.name

            filename = 'upload/' + str(time.time())

            js['name'] = filename
            os.rename(tmp_name, cap_dir + filename)

            obj = Capture(filename=filename, description=desc, analysis=analysis, owner=owner)
            obj.save()

        else:
            js['err'] = 'frames 0'
            os.remove(tmp_name)

        js = sharkd_json_dump(js)

        return HttpResponse(js, content_type="application/json")

    except ConnectionRefusedError:
        raise

@csrf_exempt
def upload_file(request):
    if request.method == 'POST':
        form = UploadFileForm(request.POST, request.FILES)
        if form.is_valid():
            owner = None
            if request.user.is_authenticated():
                owner = request.user

            return handle_uploaded_file(request.FILES['f'], owner)
