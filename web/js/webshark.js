/* webshark.js
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

var _webshark_file = "";
var _webshark_url = "/webshark/api?";

function btoa(ch)
{
	return (ch > 0x1f && ch < 0x7f) ? String.fromCharCode(ch) : '.';
}

function xtoa(hex, pad)
{
	var str = hex.toString(16);

	while (str.length < pad)
		str = "0" + str;

	return str;
}

function webshark_json_get(req)
{
	var xmlhttp = new XMLHttpRequest();

	xmlhttp.open("GET", _webshark_url + req, false);
	xmlhttp.send();
	if (xmlhttp.status == 200)
		return JSON.parse(xmlhttp.responseText);

	return null;
}

function webshark_render_columns(col)
{
	var tr = document.createElement("tr");

	for (var i = 0; i < col.length; i++)
	{
		var th = document.createElement("th");

		th.appendChild(document.createTextNode(col[i]));
		tr.appendChild(th);
	}

	var h = document.getElementById('packet_list_header');
	h.innerHTML = tr.outerHTML;
}

function webshark_frame_tr_on_click(ev)
{
	var obj = ev.target;

	/* find <tr> */
	while (obj != null && obj.data_ws_frame == undefined)
		obj = obj.parentNode;

	if (obj != null)
		webshark_load_frame(obj.data_ws_frame);
}

function webshark_tree_on_click(ev)
{
	var obj = ev.target;

	/* find <tli> */
	while (obj != null && obj.data_ws_subtree == undefined)
		obj = obj.parentNode;

	if (obj != null && obj.data_ws_subtree != undefined)
	{
		var subtree = obj.data_ws_subtree;

		if (subtree.style.display == 'none')
			subtree.style.display = 'block';
		else
			subtree.style.display = 'none';
	}
}

function webshark_render_frames(frames)
{
	var h = document.getElementById('packet_list_frames');
	h.innerHTML = '';

	for (var i = 0; i < frames.length; i++)
	{
		var cols = frames[i]['c'];
		var fnum = frames[i]['num'];

		var tr = document.createElement("tr");

		for (var j = 0; j < cols.length; j++)
		{
			var td = document.createElement("td");

			/* XXX, check if first column is equal to frame number, if so assume it's frame number column, and create link */
			if (j == 0 && cols[j] == fnum)
			{

			}

			td.appendChild(document.createTextNode(cols[j]));
			tr.appendChild(td);
		}

		tr.id = 'packet-list-frame-' + fnum;
		tr.data_ws_frame = fnum;
		tr.addEventListener("click", webshark_frame_tr_on_click);

		h.appendChild(tr);
	}
}

function webshark_create_proto_tree(tree, level)
{
	var ul = document.createElement("ul");
	var tree_li = null;

	for (var i = 0; i < tree.length; i++)
	{
		if (typeof(tree[i]) == 'string')
		{
			var li = document.createElement("li");

			li.appendChild(document.createTextNode(tree[i]));
			ul.appendChild(li);
			tree_li = li;
		}
		else
		{
			var subtree = webshark_create_proto_tree(tree[i], level + 1);
			ul.appendChild(subtree);

			var expander = document.createElement("span");
			expander.className = "tree_expander";

			expander.appendChild(document.createTextNode("\u21d2"));

			tree_li.insertBefore(expander, tree_li.firstChild);
			tree_li.addEventListener("click", webshark_tree_on_click);

			tree_li.data_ws_subtree = subtree;
		}
	}

	/* TODO: it could be set to expand by user */
	if (level > 0)
		ul.style.display = 'none';

	return ul;
}


function webshark_render_proto_tree(tree)
{
	var d = webshark_create_proto_tree(tree, 0);

	var h = document.getElementById('ws_packet_detail_view');
	h.replaceChild(d, h.firstChild);
}

function webshark_render_hexdump(pkt)
{
	var s, line;

	s = "";
	for (var i = 0; i < pkt.length; i += 16)
	{
		var limit = 16;

		var str_off = xtoa(i, 4);
		var str_hex = "";
		var str_ascii = "";

		if (i + limit > pkt.length)
			limit = pkt.length - i;

		for (var j = 0; j < limit; j++)
		{
			var ch = pkt[i + j];

			str_hex += xtoa(ch, 2) + " ";
			str_ascii += btoa(ch);
		}

		for (var j = limit; j < 16; j++)
		{
			str_hex += "  " + " ";
			str_ascii += " ";
		}

		line = str_off + "  " + str_hex + " " + str_ascii + "\n";
		s += line;
	}

	var p = document.createElement("pre");
	p.innerHTML = s;

	var h = document.getElementById('ws_packet_bytes_view');
	h.innerHTML = p.outerHTML;
}

function webshark_load_capture()
{
	var cap = webshark_json_get('req=status&capture=' + _webshark_file);

	var fra = webshark_json_get('req=frames&capture=' + _webshark_file);

	webshark_render_columns(cap['columns']);
	webshark_render_frames(fra);
}

var _webshark_current_frame = null;

function webshark_load_frame(framenum)
{
	var frame = webshark_json_get('req=frame&bytes=yes&proto=yes&capture=' + _webshark_file + '&frame=' + framenum);
	var obj;

	if (_webshark_current_frame != null)
	{
		obj = document.getElementById('packet-list-frame-' + _webshark_current_frame);
		if (obj)
			obj.className = '';
	}

	webshark_render_proto_tree(frame['tree']);
	webshark_render_hexdump(frame['bytes']);

	_webshark_current_frame = framenum;

	obj = document.getElementById('packet-list-frame-' + framenum);
	if (obj)
		obj.className = 'selected';
}
