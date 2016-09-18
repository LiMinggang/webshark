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

var _webshark_frames_html = null;

var PROTO_TREE_PADDING_PER_LEVEL = 20;

function debug(level, str)
{
	if (console && console.log)
		console.log("<" + level + "> " + str);
}

function popup(url)
{
	var newwindow = window.open(url, url, 'height=500,width=1000');

	if (window.focus)
		newwindow.focus();
}

function popup_on_click_a(ev)
{
	var url;

	url = ev.target['href'];
	if (url != null)
		popup(url);

	ev.preventDefault();
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

function webshark_get_url()
{
	var base_url = window.location.href.split("?")[0];

	var extra = '?file=' + _webshark_file;

	return base_url + extra;
}

function webshark_d3_chart(svg, data, opts)
{
	var title = opts['title'];
	var getX  = opts['getX'];

	var s1    = opts['series1'];
	var u1    = opts['unit1'];
	var sc1   = null;

	var s2    = opts['series2'];

	var s3    = opts['series3'];

	var color = opts['color'];

	var xrange = opts['xrange'];

	var margin = opts['margin'];

	if (margin == undefined)
		margin = {top: 30, right: 50, bottom: 30, left: 60};

	svg.attr("width", opts['width'])
		.attr("height", opts['height']);

	var width = opts['width'] - margin.left - margin.right,
	    height = opts['height']  - margin.top - margin.bottom;

	var g = svg.append("g")
         .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

	var x = null, y = null, y1 = null;

	if (xrange)
	{
		x = d3.scaleLinear().range([0, width]);
	}
	else
	{
		xrange = data.map(getX);
		x = d3.scaleBand().range([0, width]).padding(0.1);
	}

	x.domain(xrange);

	var series_count = 0;

	if (s1 != undefined)
	{
		var max_value = 0;

		y = d3.scaleLinear().range([height, 0]);

		if (u1 == '%')
		{
			max_value = 1;

			sc1 = [];
			for (var i = 0; i < s1.length; i++)
				sc1[i] = d3.sum(data.map(s1[i]));
		}
		else
		{
			for (var i = 0; i < s1.length; i++)
			{
				var maxx = d3.max(data.map(s1[i]));
				if (max_value < maxx) max_value = maxx;
			}
		}

		y.domain([0, max_value]);

		series_count += s1.length;
	}

	if (s2 != undefined)
	{
		var max_value = 0;

		y1 = d3.scaleLinear().range([height, 0]);

		for (var i = 0; i < s2.length; i++)
		{
			var maxx = d3.max(data.map(s2[i]));

			if (max_value < maxx) max_value = maxx;
		}

		y1.domain([0, max_value]);

		series_count += s2.length;
	}

	if (s3 != undefined)
	{
		var max_value = 0;

		y = d3.scaleLinear().range([height, 0]);

		for (var i = 0; i < s3.length; i++)
		{
			var maxx = d3.max(data.map(s3[i]));
			if (max_value < maxx) max_value = maxx;
		}

		if (max_value < 10 && u1 == 'k') max_value = 10; /* XXX, workaround, to not display mili's */

		y.domain([0, max_value]);

		series_count += s3.length;
	}

	if (color == undefined)
	{
		if (series_count < 10)
			color = d3.schemeCategory10;
		else if (series_count < 20)
			color = d3.schemeCategory20;
	}

	g.append("g")
	  .attr("class", "axis axis--x")
	  .attr("transform", "translate(0," + height + ")")
	  .call(d3.axisBottom(x));

	if (y)
	{
		if (u1 == '%')
		{
			g.append("g")
			  .attr("class", "axis axis--y")
			  .call(d3.axisLeft(y).ticks(10, '%'));

		}
		else if (u1 == 'k')
		{
			g.append("g")
			  .attr("class", "axis axis--y")
			  .call(d3.axisLeft(y).ticks().tickFormat(d3.format(".0s")));
		}
		else
		{
			g.append("g")
			  .attr("class", "axis axis--y")
			  .call(d3.axisLeft(y).ticks());
		}
	}

	if (y1)
	{
		g.append("g")
		  .attr("class", "axis axis--y")
		  .attr("transform", "translate(" + width + ",0)")
		  .call(d3.axisRight(y1).ticks());
	}

	var series_current = 0;
	var x_step = x.step ? (x.step() - 3) / series_count : 0;

	if (s1 != undefined)
	{
		for (var i = 0; i < s1.length; i++, series_current++)
		{
			var getY = s1[i];
			var scale = 1;

			var serie_x_offset = (x_step * series_current);

			if (sc1 && sc1[i])
				scale = sc1[i];

			g.selectAll(".layer" + series_current)
			  .data(data)
			 .enter().append("rect")
			  .attr("x", function(d) { return x(getX(d)) + serie_x_offset; })
			  .attr("width", x_step)
			  .attr("y", function(d) { return y(getY(d) / scale); })
			  .attr("height", function(d) { return height - y(getY(d) / scale); })
			  .attr("fill", color[series_current])
		   .append("svg:title")
		   .text(function(d) { return getY(d); });

			if (series_count == 1)
			{
				g.selectAll(".value")
				  .data(data)
				 .enter().append("text")
				  .attr("x", function(d) { return x(getX(d)) + x_step / 2; })
				  .attr("y", function(d) { return y(0.05) })
				  .attr("text-anchor", "middle")
				  .text(function(d) { return Math.floor(getY(d)); });
			}
		}
	}

	if (s2 != undefined)
	{
		for (var i = 0; i < s2.length; i++, series_current++)
		{
			var getY = s2[i];

			var serie_x_offset = (x_step * series_current);

			g.selectAll(".layer" + series_current)
			  .data(data)
			 .enter().append("rect")
			  .attr("x", function(d) { return x(getX(d)) + serie_x_offset; })
			  .attr("width", x_step)
			  .attr("y", function(d) { return y1(getY(d)); })
			  .attr("height", function(d) { return height - y1(getY(d)); })
			  .attr("fill", color[series_current])
			  .append("svg:title")
			    .text(function(d) { return getY(d); });
		}
	}

	if (s3 != undefined)
	{
		for (var i = 0; i < s3.length; i++, series_current++)
		{
			var getY = s3[i];

			var area = d3.area()
				.x(function(d) { return x(getX(d)); })
				.y0(height)
				.y1(function(d) { return y(getY(d)); });

			g.append("path")
				.data([data])
				.attr("d", area)
				.attr("fill", color[series_current])
		}
	}

	if (opts['title'])
	{
		g.append("text")
		  .attr("x", width / 2)
		  .attr("y", -(margin.top / 2))
		  .attr("text-anchor", "middle")
		  .text(opts['title']);
	}
}

function dom_add_class(node, name)
{
	node.className += " " + name;
}

function dom_remove_class(node, name)
{
	var classes = node.className.split(" ");

	node.className = "";
	for (var i = 0; i < classes.length; i++)
	{
		if (classes[i] != name)
			node.className = node.className + " " + classes[i];
	}
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

	debug(3, " webshark_json_get(" + req + ") sending request");

	http.open("GET", _webshark_url + req, true);
	http.onreadystatechange =
		function()
		{
			if (http.readyState == 4 && http.status == 200)
			{
				debug(3, " webshark_json_get(" + req + ") got 200 len = " + http.responseText.length);

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

var _prev_filter_on_click = null;

function webshark_filter_on_click(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_filter');
	if (node != null)
	{
		if (_prev_filter_on_click)
			dom_remove_class(_prev_filter_on_click, "selected");

		dom_add_class(node, "selected");
		_prev_filter_on_click = node;

		var filter = node['data_ws_filter'];
		document.getElementById('ws_packet_list_view').style.display = 'block';
		webshark_load_capture(filter);
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

function webshark_frame_on_click(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (node != null)
		popup(webshark_get_url() + "&frame=" + node.data_ws_frame);

	ev.preventDefault();
}

var _webshark_capture_frames = null;

function webshark_create_frame_html(frame)
{
	var frame = _webshark_capture_frames[frame];

	var cols = frame['c'];
	var fnum = frame['num'];

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
			a.setAttribute("href", webshark_get_url() + "&frame=" + fnum);
			a.addEventListener("click", webshark_frame_on_click);

			td.appendChild(a);
		}
		else
		{
			td.appendChild(document.createTextNode(cols[j]));
		}

		tr.appendChild(td);
	}

	if (frame['bg'])
		tr.style['background-color'] = '#' + frame['bg'];

	if (frame['fg'])
		tr.style['color'] = '#' + frame['fg'];

	tr.id = 'packet-list-frame-' + fnum;
	tr.data_ws_frame = fnum;
	tr.addEventListener("click", webshark_frame_tr_on_click);

	return tr;
}

function webshark_lazy_frames(frames)
{
	_webshark_capture_frames = frames;

	var data = Array();
	data.length = frames.length;
	_webshark_frames_html.options.callbacks.createHTML = webshark_create_frame_html;

	// don't work _webshark_frames_html.scroll_elem.scrollTop = 0;
	_webshark_frames_html.update(data);
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
			var ch = pkt.charCodeAt(i + j);

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

var webshark_stat_fields =
{
	'name': 'Topic / Item',
	'count': 'Count',
	'avg': 'Average',
	'min': 'Min val',
	'max': 'Max val',
	'rate': 'Rate (ms)',
	'perc': 'Percent',
	'burstcount': 'Burst count',
	'burstrate': 'Burst rate',
	'bursttime': 'Burst start'
};

var webshark_conv_fields =
{
	'saddr': 'Address A',
	'sport': 'Port A',
	'daddr': 'Address B',
	'dport': 'Port B',
	'_packets': 'Packets',
	'_bytes': 'Bytes',
	'txf': 'Packets A -> B',
	'txb': 'Bytes A -> B',
	'rxf': 'Packets A <- B',
	'rxb': 'Bytes A <- B',
	'start': 'Rel start',
	'_duration': 'Duration',
	'_rate_tx': 'bps A->B',
	'_rate_rx': 'bps A<-B'
};

var webshark_host_fields =
{
	'host': 'Address',
	'port': 'Port',
	'_packets' : 'Packets',
	'_bytes': 'Bytes',
	'txf': 'TX Packets',
	'txb': 'TX Bytes',
	'rxf': 'RX Packets',
	'rxb': 'RX Bytes'
};

var webshark_voip_calls_fields =
{
	'start':   'Start Time',
	'stop':    'Stop Time',
	'initial': 'Initial Speaker',
	'from':    'From',
	'to':      'To',
	'proto':   'Protocol',
	'pkts':    'Packets',
	'state':   'State',
	'comment': 'Comments'
};

function webshark_create_tap_table_common(fields)
{
	var table = document.createElement('table');
	var tr;

	tr = document.createElement('tr');

	{
		var td = document.createElement('td');

		td.appendChild(document.createTextNode('Actions'));
		td.className = "ws_border";
		tr.appendChild(td);
	}

	for (var col in fields)
	{
		var td = document.createElement('td');

		td.appendChild(document.createTextNode(fields[col]));
		td.className = "ws_border";
		tr.appendChild(td);
	}
	tr.className = "header";

	table.className = "ws_border";

	table.appendChild(tr);
	return table;
}

function webshark_create_tap_table_data_common(fields, table, data)
{
	for (var i = 0; i < data.length; i++)
	{
		var val = data[i];

		var tr = document.createElement('tr');

		tr.appendChild(webshark_create_tap_action_common(val));

		for (var col in fields)
		{
			var value = val[col];

			/* TODO, hide fields which are undefined for whole table */
			if (value == undefined)
				value = '-';

			var td = document.createElement('td');
			td.appendChild(document.createTextNode(value));
			td.className = "ws_border";
			tr.appendChild(td);
		}

		if (val['_filter'])
		{
			tr.data_ws_filter = val['_filter'];
			tr.addEventListener("click", webshark_filter_on_click);
		}

		table.appendChild(tr);
	}
}

function webshark_create_tap_action_common(data)
{
	var td = document.createElement('td');

	if (data['_filter'])
	{
		var filter_a = document.createElement('a');

		filter_a.setAttribute("target", "_blank");
		filter_a.setAttribute("href", webshark_get_url()+ "&filter=" + encodeURIComponent(data['_filter']));
		filter_a.addEventListener("click", popup_on_click_a);

		filter_a.appendChild(document.createTextNode('F'));
		td.appendChild(filter_a);
	}

	td.className = "ws_border";

	return td;
}

function webshark_create_tap_stat(table, stats, level)
{
	for (var i = 0; i < stats.length; i++)
	{
		var stat = stats[i];
		var val = stat['vals'];

		var tr = document.createElement('tr');

		tr.appendChild(webshark_create_tap_action_common(stat));

		for (var col in webshark_stat_fields)
		{
			var value = stat[col];

			/* TODO, hide fields which are undefined for whole table */
			if (value == undefined)
				value = '-';
			else if (col == 'perc')
				value = value + '%';

			var td = document.createElement('td');
			td.appendChild(document.createTextNode(value));
			tr.appendChild(td);
			td.className = "ws_border";
		}

		{
			var td = document.createElement('td');
			td.appendChild(document.createTextNode(level));
			tr.appendChild(td);
		}

		table.appendChild(tr);

		if (stat['sub'])
			webshark_create_tap_stat(table, stat['sub'], level + 1);
	}
}

function webshark_render_tap(tap)
{
	if (tap['type'] == 'stats')
	{
		var label = document.createElement("p");
		label.appendChild(document.createTextNode("---" + tap['name']));

		var table = webshark_create_tap_table_common(webshark_stat_fields);

		webshark_create_tap_stat(table, tap['stats'], 0);

		document.getElementById('toolbar_tap').appendChild(label);
		document.getElementById('toolbar_tap').appendChild(table);

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, tap['stats'][0]['sub'],
		{
			title: tap['stats'][0]['name'],
			width: 1000, height: 400,

			getX: function(d) { return d['name'] },

			unit1: '%',

			series1:
			[
				function(d) { return d['count']; }
			],

			color: [ 'steelblue' ]
		});

		document.getElementById('toolbar_tap').appendChild(svg.node());
	}
	else if (tap['type'] == 'conv')
	{
		var table = webshark_create_tap_table_common(webshark_conv_fields);
		var convs = tap['convs'];

		for (var i = 0; i < convs.length; i++)
		{
			var conv = convs[i];

			if (conv['sport'])
				conv['_name'] = conv['saddr'] + ':' + conv['sport'] + " <===>" + conv['daddr'] + ':' + conv['dport'];
			else
				conv['_name'] = conv['saddr'] + " <===>" + conv['daddr'];

			conv['_packets']  = conv['rxf'] + conv['txf'];
			conv['_bytes']    = conv['rxb'] + conv['txb'];
			conv['_duration'] = conv['stop'] - conv['start'];
			conv['_rate_tx'] = (8 * conv['txb']) / conv['_duration'];
			conv['_rate_rx'] = (8 * conv['rxb']) / conv['_duration'];

			conv['_filter'] = conv['filter'];
		}

		webshark_create_tap_table_data_common(webshark_conv_fields, table, convs);

		document.getElementById('toolbar_tap').appendChild(table);

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, convs,
		{
			title: tap['proto'] + ' Conversations - Frames Count',
			width: 800, height: 400,

			getX: function(d) { return d['_name']; },

			series2:
			[
				function(d) { return d['rxf']; },
				function(d) { return d['txf']; }
			],

			color: [ '#d62728', '#2ca02c' ],
			// color: [ '#e377c2', '#bcbd22' ],
		});

		document.getElementById('toolbar_tap').appendChild(svg.node());

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, convs,
		{
			title: tap['proto'] + ' Conversations - Bytes Count',
			width: 800, height: 400,

			getX: function(d) { return d['_name']; },

			series1:
			[
				function(d) { return d['rxb']; },
				function(d) { return d['txb']; }
			],

			color: [ '#d62728', '#2ca02c' ],
		});

		document.getElementById('toolbar_tap').appendChild(svg.node());

	}
	else if (tap['type'] == 'host')
	{
		var table = webshark_create_tap_table_common(webshark_host_fields);
		var hosts = tap['hosts'];

		for (var i = 0; i < hosts.length; i++)
		{
			var host = hosts[i];
			if (host['port'])
				host['_name'] = host['host'] + ':' + host['port'];
			else
				host['_name'] = host['host'];

			host['_packets']  = host['rxf'] + host['txf'];
			host['_bytes']    = host['rxb'] + host['txb'];
			host['_filter']   = host['filter'];
		}

		webshark_create_tap_table_data_common(webshark_host_fields, table, hosts);

		document.getElementById('toolbar_tap').appendChild(table);

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, hosts,
		{
			title: tap['proto'] + ' Endpoints - Frames Count',
			width: 800, height: 400,

			getX: function(d) { return d['_name']; },

			series2:
			[
				function(d) { return d['rxf']; },
				function(d) { return d['txf']; }
			],

			color: [ '#d62728', '#2ca02c' ],
			// color: [ '#e377c2', '#bcbd22' ],
		});

		document.getElementById('toolbar_tap').appendChild(svg.node());

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, hosts,
		{
			title: tap['proto'] + ' Endpoints - Bytes Count',
			width: 800, height: 400,

			getX: function(d) { return d['_name']; },

			series1:
			[
				function(d) { return d['rxb']; },
				function(d) { return d['txb']; }
			],

			color: [ '#d62728', '#2ca02c' ],
		});

		document.getElementById('toolbar_tap').appendChild(svg.node());
	}
	else if (tap['type'] == 'voip-calls')
	{
		var table = webshark_create_tap_table_common(webshark_voip_calls_fields);
		var calls = tap['calls'];

		for (var i = 0; i < calls.length; i++)
		{
			var call = calls[i];

			/* TODO, generate comment for VOIP_ISUP, VOIP_H323 */

			call['_filter'] = call['filter'];
		}

		webshark_create_tap_table_data_common(webshark_voip_calls_fields, table, calls);

		document.getElementById('toolbar_tap').appendChild(table);
	}
}

var _webshark_interval = null;
var _webshark_interval_mode = "";

function webshark_render_interval()
{
	var intervals_data = _webshark_interval['intervals'];
	var intervals_full = [ ];

	var count_idx =
		(_webshark_interval_mode == "bps") ? 2 :
		(_webshark_interval_mode == "fps") ? 1 :
		-1;

	if (count_idx == -1)
		return;

	for (var i = 0; i <= _webshark_interval['last']; i++)
		intervals_full[i] = [ i, 0 ];

	for (var i = 0; i < intervals_data.length; i++)
	{
		var idx = intervals_data[i][0];

		intervals_full[idx][1] += intervals_data[i][count_idx];
	}

	var svg = d3.select("body").append("svg").remove();

	webshark_d3_chart(svg, intervals_full,
	{
		width: 620, height: 100,
		margin: {top: 0, right: 10, bottom: 20, left: 40},

		xrange: [ 0, _webshark_interval['last'] ],

		getX: function(d) { return d[0]; },

		unit1: 'k',
		series3:
		[
			function(d) { return d[1]; }
		],

		color: [ 'steelblue' ]
	});

	dom_set_child(document.getElementById('capture_interval'), svg.node());
}

function webshark_load_capture(filter, cols)
{
	var extra = "";

	if (filter)
		extra += "&filter=" + encodeURIComponent(filter);

	if (cols)
	{
		for (var i = 0; i < cols.length; i++)
			extra += "&column" + i + "=" + encodeURIComponent(cols[i]);
	}

	webshark_json_get('req=frames&capture=' + _webshark_file + extra,
		function(data)
		{
			webshark_lazy_frames(data);

			if (data && data[0])
			{
				var framenum = data[0].num;
				webshark_load_frame(framenum);
			}
		});

	webshark_json_get('req=intervals&capture=' + _webshark_file,
		function(data)
		{
			_webshark_interval = data;
			webshark_render_interval();
		});
}

var _webshark_current_node = null;

function webshark_node_highlight_bytes(obj, node)
{
	/* unselect previous */
	if (_webshark_current_node != null)
		dom_remove_class(_webshark_current_node, "selected");

	/* select new */
	_webshark_current_node = obj;
	dom_add_class(obj, 'selected');
}

var _webshark_current_frame = null;

function webshark_load_frame(framenum, cols)
{
	/* frame content should not change -> skip requests for frame like current one */
	if (framenum == _webshark_current_frame)
		return;

	/* unselect previous */
	if (_webshark_current_frame != null)
	{
		var obj = document.getElementById('packet-list-frame-' + _webshark_current_frame);
		if (obj)
			dom_remove_class(obj, "selected");
	}

	webshark_json_get('req=frame&bytes=yes&proto=yes&capture=' + _webshark_file + '&frame=' + framenum,
		function(data)
		{
			webshark_render_proto_tree(data['tree']);
			webshark_render_hexdump(window.atob(data['bytes']));

			_webshark_current_frame = framenum;

			/* select new */
			var obj = document.getElementById('packet-list-frame-' + framenum);
			if (obj)
				dom_add_class(obj, 'selected');
		});
}

function webshark_load_tap(taps)
{
	var tap_req = "";

	for (var i = 0; i < taps.length; i++)
		tap_req = tap_req + "&tap" + i + "=" + taps[i];

	webshark_json_get('req=tap&capture=' + _webshark_file + tap_req,
		function(data)
		{
			for (var i = 0; i < data['taps'].length - 1; i++)
				webshark_render_tap(data['taps'][i]);
		});
}
