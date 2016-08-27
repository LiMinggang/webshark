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

var PROTO_TREE_PADDING_PER_LEVEL = 20;

function debug(level, str)
{
	if (console && console.log)
		console.log("<" + level + "> " + str);
}

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

function dom_clear(p)
{
	p.innerHTML = "";
}

function dom_set_child(p, ch)
{
	dom_clear(p);
	p.appendChild(ch);
}

function dom_find_node_attr(n, attr)
{
	while (n != null)
	{
		if (n[attr] != undefined)
			return n;

		n = n.parentNode;
	}

	return null;
}

function webshark_json_get(req, cb)
{
	var http = new XMLHttpRequest();

	debug(3," webshark_json_get(" + req + ") sending request");

	http.open("GET", _webshark_url + req, true);
	http.onreadystatechange = function()
	{
		if (http.readyState == 4 && http.status == 200)
		{
			debug(3," webshark_json_get(" + req + ") got 200 len = " + http.responseText.length);

			var js = JSON.parse(http.responseText);
			cb(js);
		}
	};

	http.send(null);
}

function webshark_render_columns(col)
{
	var tr = document.createElement("tr");

	for (var i = 0; i < col.length; i++)
	{
		var th = document.createElement("th");

th.width = Math.floor(1000 / col.length) +"px"; // XXX, temporary

		th.appendChild(document.createTextNode(col[i]));
		tr.appendChild(th);
	}

	dom_set_child(document.getElementById('packet_list_header'), tr);
}

function webshark_frame_tr_on_click(ev)
{
	var frame_node;

	frame_node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (frame_node != null)
		webshark_load_frame(frame_node.data_ws_frame);
}

function webshark_tree_on_click(ev)
{
	var tree_node;
	var node;

	tree_node = dom_find_node_attr(ev.target, 'data_ws_subtree');
	if (tree_node)
	{
		var subtree = tree_node.data_ws_subtree;

		if (subtree.style.display == 'none')
			subtree.style.display = 'block';
		else
			subtree.style.display = 'none';
	}
}

function webshark_node_on_click(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_node');
	if (node != null)
	{
		if (_webshark_current_node == node)
			webshark_tree_on_click(ev);

		webshark_node_highlight_bytes(node, node.data_ws_node);
	}
}

function webshark_render_frames(frames)
{
	var h = document.getElementById('packet_list_frames');

	dom_clear(h);

	for (var i = 0; i < frames.length; i++)
	{
		var cols = frames[i]['c'];
		var fnum = frames[i]['num'];

		var tr = document.createElement("tr");

		for (var j = 0; j < cols.length; j++)
		{
			var td = document.createElement("td");

td.width = Math.floor(1000 / cols.length) + "px"; // XXX, temporary

			/* XXX, check if first column is equal to frame number, if so assume it's frame number column, and create link */
			if (j == 0 && cols[j] == fnum)
			{
				var a = document.createElement('a');

				a.appendChild(document.createTextNode(cols[j]))

				a.setAttribute("target", "_blank");
				a.setAttribute("href", window.location.href + "&frame=" + fnum);

// browse_printf(cli, "<a onclick='return popframe(%u)' target='_blank' href='/frame/%u'>", fdata->num, fdata->num);
				td.appendChild(a);
			}
			else
			{
				td.appendChild(document.createTextNode(cols[j]));
			}

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

	for (var i = 0; i < tree.length; i++)
	{
		var finfo = tree[i];

		var li = document.createElement("li");
		li.appendChild(document.createTextNode(finfo['l']));
		ul.appendChild(li);

		if (finfo['s'])
			li.className = 'ws_cell_expert_color_' + finfo['s'];
		else if (finfo['t'] == "proto")
			li.className = 'ws_cell_protocol';

		li.data_ws_node = 1;
		li.addEventListener("click", webshark_node_on_click);

		li.style['padding-left'] = (level * PROTO_TREE_PADDING_PER_LEVEL) + "px";

		if (finfo['n'])
		{
			var expander = document.createElement("span");
			expander.className = "tree_expander";

			expander.appendChild(document.createTextNode("\u21d2"));

			var subtree = webshark_create_proto_tree(finfo['n'], level + 1);
			ul.appendChild(subtree);

			li.insertBefore(expander, li.firstChild);

			li.data_ws_subtree = subtree;
			expander.addEventListener("click", webshark_tree_on_click);
		}
	}

	/* TODO: it could be set to expand by user */
	if (level > 1)
		ul.style.display = 'none';

	return ul;
}


function webshark_render_proto_tree(tree)
{
	var d = webshark_create_proto_tree(tree, 1);

	dom_set_child(document.getElementById('ws_packet_detail_view'), d);
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

	dom_set_child(document.getElementById('ws_packet_bytes_view'), p);
}

function webshark_load_capture()
{
	webshark_json_get('req=status&capture=' + _webshark_file,
		function(data)
		{
			webshark_render_columns(data['columns']);
		});

	webshark_json_get('req=frames&capture=' + _webshark_file,
		function(data)
		{
			webshark_render_frames(data);
		});
}

var _webshark_current_node = null;

function webshark_node_highlight_bytes(obj, node)
{
	/* unselect previous */
	if (_webshark_current_node != null)
	{
		_webshark_current_node.className = '';
	}

	/* select new */
	_webshark_current_node = obj;
	obj.className = 'selected';
}

var _webshark_current_frame = null;

function webshark_load_frame(framenum)
{
	/* frame content should not change -> skip requests for frame like current one */
	if (framenum == _webshark_current_frame)
		return;

	/* unselect previous */
	if (_webshark_current_frame != null)
	{
		var obj = document.getElementById('packet-list-frame-' + _webshark_current_frame);
		if (obj)
			obj.className = '';
	}

	webshark_json_get('req=frame&bytes=yes&proto=yes&capture=' + _webshark_file + '&frame=' + framenum,
		function(data)
		{
			webshark_render_proto_tree(data['tree']);
			webshark_render_hexdump(data['bytes']);

			_webshark_current_frame = framenum;

			/* select new */
			var obj = document.getElementById('packet-list-frame-' + framenum);
			if (obj)
				obj.className = 'selected';
		});
}
