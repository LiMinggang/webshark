/* webshark.js
 *
 * Copyright (C) 2016 Jakub Zawadzki
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

var _webshark_file = "";
var _webshark_url = "/webshark/api?";

var _webshark_files_html = null;
var _webshark_frames_html = null;
var _webshark_hexdump_html = null;

var _webshark = null;

var PROTO_TREE_PADDING_PER_LEVEL = 20;

var column_downloading = 42;

function Hexdump(opts)
{
	this.datas = null;
	this.active= -1;
	this.base  = opts.base;
	this.elem  = document.getElementById(opts.contentId);

	this.highlights = [ ];
}

Hexdump.prototype.render_hexdump = function()
{
	var s, line;

	var pkt = this.datas[this.active];

	var padcount = (this.base == 2) ? 8 : (this.base == 16) ? 2 : 0;
	var limit = (this.base == 2) ? 8 : (this.base == 16) ? 16 : 0;

	var emptypadded = "  ";
	while (emptypadded.length < padcount)
		emptypadded = emptypadded + emptypadded;

	if (limit == 0)
		return;

	var full_limit = limit;

	s = "";
	for (var i = 0; i < pkt.length; i += full_limit)
	{
		var str_off = "<span class='hexdump_offset'>" + xtoa(i, 4) + " </span>";
		var str_hex = "";
		var str_ascii = "";

		var prev_class = "";

		if (i + limit > pkt.length)
			limit = pkt.length - i;

		for (var j = 0; j < limit; j++)
		{
			var ch = pkt.charCodeAt(i + j);

			var cur_class = "";

			for (var k = 0; k < this.highlights.length; k++)
			{
				if (this.highlights[k].tab == this.active && this.highlights[k].start <= (i + j) && (i + j) < this.highlights[k].end)
				{
					cur_class = this.highlights[k].style;
					break;
				}
			}

			if (prev_class != cur_class)
			{
				if (prev_class != "")
				{
					/* close span for previous class */
					str_ascii += "</span>";
					str_hex += "</span>";
				}

				if (cur_class != "")
				{
					/* open span for new class */
					str_hex += "<span class='" + cur_class + "'>";
					str_ascii += "<span class='" + cur_class + "'>";
				}

				prev_class = cur_class;
			}

			str_ascii += chtoa(ch);

			var numpad = ch.toString(this.base);
			while (numpad.length < padcount)
				numpad = '0' + numpad;

			str_hex += numpad + " ";
		}

		if (prev_class != "")
		{
			str_ascii += "</span>";
			str_hex += "</span>";
		}

		for (var j = limit; j < full_limit; j++)
		{
			str_hex += emptypadded + " ";
			str_ascii += " ";
		}

		line = str_off + " " + str_hex + " " + str_ascii + "\n";
		s += line;
	}

	this.elem.innerHTML = s;
};

function Webshark()
{
	this.cols = null;
	this.filter = null;

	this.fetch_columns_limit = 120;

	this.cached_columns = [ ];
}

Webshark.prototype.setColumns = function(user_cols)
{
	this.cols = user_cols;
};

Webshark.prototype.setFilter = function(new_filter)
{
	this.filter = new_filter;
	this.cached_columns = [ ];

	this.update();
};

Webshark.prototype.update = function()
{
	var extra = "";

	if (this.filter)
		extra += "&filter=" + encodeURIComponent(this.filter);

	var that = this;

	/* XXX, first need to download intervals to know how many rows we have, rewrite */
	webshark_json_get('req=intervals&capture=' + _webshark_file + extra,
		function(data)
		{
			if (that.filter)
			{
				_webshark_interval_filter = data;
			}
			else
			{
				_webshark_interval = data;
				_webshark_interval_filter = null; /* render only main */
			}

			/* XXX, broken */
			try {
				webshark_render_interval();
			} catch(ex) { }

			that.cached_columns = [ ];
			that.cached_columns.length = data['frames'];
			webshark_lazy_frames(that.cached_columns);

			that.fetchColumns(0, true);
		});
};

Webshark.prototype.fetchColumns = function(skip, load_first)
{
	var extra = "";

	if (this.fetch_columns_limit != 0)
		extra += "&limit=" + this.fetch_columns_limit;

	if (skip != 0)
		extra += "&skip=" + skip;

	if (this.filter)
		extra += "&filter=" + encodeURIComponent(this.filter);

	for (var i = 0; i < this.fetch_columns_limit && skip + i < this.cached_columns.length; i++)
	{
		if (!this.cached_columns[skip + i])
			this.cached_columns[skip + i] = column_downloading;
	}

	if (this.cols)
	{
		for (var i = 0; i < this.cols.length; i++)
			extra += "&column" + i + "=" + encodeURIComponent(this.cols[i]);
	}

	var that = this;

	webshark_json_get('req=frames&capture=' + _webshark_file + extra,
		function(data)
		{
			if (data)
			{
				for (var i = 0; i < data.length; i++)
					that.cached_columns[skip + i] = data[i];
				webshark_lazy_frames(that.cached_columns);
			}

			if (load_first && data && data[0])
			{
				var framenum = data[0].num;
				webshark_load_frame(framenum);
			}
		});
};


function debug(level, str)
{
	if (console && console.log)
		console.log("<" + level + "> " + str);
}

function prec_trunc(x, num)
{
	var xnum = x * num;
	return Math.round(xnum) / x;
}

function popup(url)
{
	var newwindow = window.open(url, url, 'height=500,width=1000');

	if (window.focus)
		newwindow.focus();
}

function popup_on_click_a(ev)
{
	var node;
	var url;

	node = dom_find_node_attr(ev.target, 'href');
	if (node != null)
	{
		url = node['href'];
		if (url != null)
			popup(url);

		ev.preventDefault();
	}
}

function chtoa(ch)
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

var glyph_cache = { };

function webshark_glyph(what)
{
	if (glyph_cache[what])
		return glyph_cache[what];

	var fa_paths =
	{
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/caret-right.svg */
		'collapsed': "M1152 896q0 26-19 45l-448 448q-19 19-45 19t-45-19-19-45v-896q0-26 19-45t45-19 45 19l448 448q19 19 19 45z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/caret-down.svg */
		'expanded': "M1408 704q0 26-19 45l-448 448q-19 19-45 19t-45-19l-448-448q-19-19-19-45t19-45 45-19h896q26 0 45 19t19 45z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/filter.svg */
		'filter': "M1595 295q17 41-14 70l-493 493v742q0 42-39 59-13 5-25 5-27 0-45-19l-256-256q-19-19-19-45v-486l-493-493q-31-29-14-70 17-39 59-39h1280q42 0 59 39z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/play.svg */
		'play': "M1576 927l-1328 738q-23 13-39.5 3t-16.5-36v-1472q0-26 16.5-36t39.5 3l1328 738q23 13 23 31t-23 31z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/stop.svg */
		'stop': "M1664 192v1408q0 26-19 45t-45 19h-1408q-26 0-45-19t-19-45v-1408q0-26 19-45t45-19h1408q26 0 45 19t19 45z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/download.svg */
		'download': "M1344 1344q0-26-19-45t-45-19-45 19-19 45 19 45 45 19 45-19 19-45zm256 0q0-26-19-45t-45-19-45 19-19 45 19 45 45 19 45-19 19-45zm128-224v320q0 40-28 68t-68 28h-1472q-40 0-68-28t-28-68v-320q0-40 28-68t68-28h465l135 136q58 56 136 56t136-56l136-136h464q40 0 68 28t28 68zm-325-569q17 41-14 70l-448 448q-18 19-45 19t-45-19l-448-448q-31-29-14-70 17-39 59-39h256v-448q0-26 19-45t45-19h256q26 0 45 19t19 45v448h256q42 0 59 39z"
	};

	var svg;
	switch (what)
	{
		case 'collapsed':
		case 'expanded':
		case 'filter':
		case 'play':
		case 'stop':
		case 'download':
		{
			svg = d3.select("body").append("svg").remove()
			   .attr("width", 1792)
			   .attr("height", 1792)
			   .attr("viewBox", "0 0 1792 1792")
			   .attr("xmlns", "http://www.w3.org/2000/svg");

			svg.append("svg:path")
			    .attr("d", fa_paths[what])
			    .style("fill", "#191970");
			break;
		}
	}

	var str = 'data:image/svg+xml;base64,' + window.btoa(svg.node().outerHTML);
	glyph_cache[what] = str;
	return str;
}

function webshark_glyph_img(what, width)
{
	var img = document.createElement('img');

	img.setAttribute('src', webshark_glyph(what));
	img.setAttribute('width', width);
	return img;
}

function webshark_d3_chart(svg, data, opts)
{
	var title = opts['title'];
	var getX  = opts['getX'];

	var s1    = opts['series1'];
	var u1    = opts['unit1'];
	var sc1   = opts['scale1'];

	var s2    = opts['series2'];

	var s3    = opts['series3'];

	var color = opts['color'];

	var xrange = opts['xrange'];

	var margin = opts['margin'];

	var full_width = opts['width'];

	if (margin == undefined)
		margin = {top: 30, right: 50, bottom: 30, left: 60};

	if (full_width == undefined)
		full_width = margin.left + opts['iwidth'] * data.length + margin.right;

	if (opts['mwidth'])
	{
		var mwidth = opts['mwidth'];
		if (full_width < mwidth) full_width = mwidth;
	}

	svg.attr("width", full_width)
		.attr("height", opts['height']);

	var width = full_width - margin.left - margin.right,
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

			if (sc1 == undefined)
			{
				sc1 = [];
				for (var i = 0; i < s1.length; i++)
					sc1[i] = d3.sum(data.map(s1[i]));
			}
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

function dom_create_label_span(str)
{
	var label = document.createElement("span");

	label.appendChild(document.createTextNode(str));

	return label;
}

function dom_create_label(str)
{
	var label = document.createElement("p");

	label.setAttribute('align', 'center');
	label.appendChild(document.createTextNode(str));

	return label;
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

function webshark_frame_row_on_click(ev)
{
	var frame_node;

	frame_node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (frame_node != null)
		webshark_load_frame(frame_node.data_ws_frame);
}

var _webshark_selected_file = null;

function webshark_create_file_details(file)
{
	var div = document.createElement('div');
	var p;

	a = document.createElement('a');

	a.appendChild(document.createTextNode('Load'));
	a.setAttribute("href", file['url']);
	div.appendChild(a);

	p = document.createElement('p');
	p.appendChild(document.createTextNode('File: ' + file['name']));
	div.appendChild(p);

	p = document.createElement('p');
	p.appendChild(document.createTextNode('Size: ' + file['size']));
	div.appendChild(p);

	if (file['analysis'])
	{
		p = document.createElement('p');
		p.appendChild(document.createTextNode('Frames: ' + file['analysis']['frames']));
		div.appendChild(p);

		/* Time */
		var first = file['analysis']['first'];
		var last  = file['analysis']['last'];

		if (first && last)
		{
			var dura  = last - first;

			var format = d3.utcFormat; /* XXX, check if UTC */

			p = document.createElement('p');
			p.appendChild(document.createTextNode('From: ' + format(new Date(first * 1000))));
			div.appendChild(p);

			p = document.createElement('p');
			p.appendChild(document.createTextNode('To: ' + format(new Date(last * 1000))));
			div.appendChild(p);

			p = document.createElement('p');
			p.appendChild(document.createTextNode('Duration: ' + (last - first) + " s"));
			div.appendChild(p);
		}

		/* Protocols */
		var protos = file['analysis']['protocols'];
		if (protos && protos.length > 0)
		{
			var ul = document.createElement('ul')
			ul.className = 'proto';

			div.appendChild(document.createElement('p').appendChild(document.createTextNode('Protocols:')));
			for (var k = 0; k < protos.length; k++)
			{
				var proto_li = document.createElement('li');

				proto_li.appendChild(document.createTextNode(protos[k]));
				proto_li.className = 'proto';

				ul.appendChild(proto_li);
			}
			div.appendChild(ul);
		}
	}

	return div;
}

function webshark_file_row_on_click(ev)
{
	var file_node;

	file_node = dom_find_node_attr(ev.target, 'ws_file_data');

	if (file_node == _webshark_selected_file)
	{
		/* TODO: after double(triple?) clicking auto load file? */
		return;
	}

	if (file_node != null)
	{
		var file = file_node['ws_file_data'];

		file['url'] = window.location.href + '?file=' + file['name'];

		var div = webshark_create_file_details(file);

		/* unselect previous */
		if (_webshark_selected_file != null)
			dom_remove_class(_webshark_selected_file, "selected");

		dom_set_child(document.getElementById('capture_files_view_details'), div);

		/* select new */
		dom_add_class(file_node, "selected");
		_webshark_selected_file = file_node;
	}
}

function webshark_tree_sync(subtree)
{
	if (subtree['expanded'] == false)
	{
		subtree['tree'].style.display = 'none';
		subtree['exp'].style.display = 'none';
		subtree['col'].style.display = 'inline';
	}
	else
	{
		subtree['tree'].style.display = 'block';
		subtree['exp'].style.display = 'inline';
		subtree['col'].style.display = 'none';
	}
}

function webshark_tree_on_click(ev)
{
	var tree_node;
	var node;

	tree_node = dom_find_node_attr(ev.target, 'data_ws_subtree');
	if (tree_node)
	{
		var subtree = tree_node.data_ws_subtree;

		subtree['expanded'] = !subtree['expanded'];
		webshark_tree_sync(subtree);

		if (subtree['ett'])
			sessionStorage.setItem("ett-" + subtree['ett'], subtree['expanded'] ? '1' : '0');
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

		_webshark.setFilter(filter);
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

function webshark_frame_goto(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (node != null)
	{
		webshark_load_frame(node.data_ws_frame);
		// TODO: also scroll table to that position.
	}

	ev.preventDefault();
}

function webshark_create_file_row_html(file, row_no)
{
	var tr = document.createElement("tr");

	var si_format = d3.format('.2s');

	var stat = file['status'];

	var data = [
		file['name'],
		si_format(file['size']) + "B",
		file['desc'],
	];

	for (var j = 0; j < data.length; j++)
	{
		var td = document.createElement("td");

		if (j == 0) /* before filename */
		{
			if (stat && stat['online'])
			{
				var glyph = webshark_glyph_img('play', 16);
				glyph.setAttribute('alt', 'Running');
				glyph.setAttribute('title', 'Running ...');

				td.appendChild(glyph);
			}
			else
			{
				var glyph = webshark_glyph_img('stop', 16);
				glyph.setAttribute('alt', 'Stopped');
				glyph.setAttribute('title', 'Stopped');

				td.appendChild(glyph);
			}
			td.appendChild(document.createTextNode(' '));
		}

		td.appendChild(document.createTextNode(data[j]));
		tr.appendChild(td);
	}

	if (stat && stat['online'] == true)
	{
		tr.style['background-color'] = 'lightblue';
	}
	else
	{
		tr.style['background-color'] = '#ccc';
	}

	tr.ws_file_data = file;
	tr.addEventListener("click", webshark_file_row_on_click);

	return tr;
}

function webshark_create_frame_row_html(frame, row_no)
{
	var tr = document.createElement("tr");

	if (!frame)
	{
		_webshark.fetchColumns(row_no, false);
		return tr;
	}

	if (frame == column_downloading)
		return tr;

	var cols = frame['c'];
	var fnum = frame['num'];

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
	tr.addEventListener("click", webshark_frame_row_on_click);

	return tr;
}

function webshark_lazy_frames(frames)
{
	_webshark_frames_html.options.callbacks.createHTML = webshark_create_frame_row_html;

	// don't work _webshark_frames_html.scroll_elem.scrollTop = 0;
	_webshark_frames_html.setData(frames);
}

function webshark_create_proto_tree(tree, proto_tree, level)
{
	var ul = document.createElement("ul");

	for (var i = 0; i < tree.length; i++)
	{
		var finfo = tree[i];

		var li = document.createElement("li");
		var txt_node = document.createTextNode(finfo['l']);

		if (finfo['s'])
			li.className = 'ws_cell_expert_color_' + finfo['s'];
		else if (finfo['t'] == "proto")
			li.className = 'ws_cell_protocol';
		else if (finfo['t'] == "url")
		{
			// TODO: url in finfo['url'] but not trusted, so don't generate link.
			li.className = 'ws_cell_link';
		}
		else if (finfo['t'] == "framenum")
		{
			var a = document.createElement('a');

			a.appendChild(txt_node);

			a.setAttribute("target", "_blank");
			a.setAttribute("href", webshark_get_url() + "&frame=" + finfo['fnum']);
			a.addEventListener("click", webshark_frame_goto);

			a.data_ws_frame = finfo['fnum'];

			txt_node = a;
		}

		li.appendChild(txt_node);
		ul.appendChild(li);

		if (level > 1 && proto_tree['h'] != undefined)
		{
			finfo['p'] = proto_tree['h'];
			finfo['p_ds'] = proto_tree['ds'];
		}

		li.data_ws_node = finfo;
		li.addEventListener("click", webshark_node_on_click);

		li.style['padding-left'] = (level * PROTO_TREE_PADDING_PER_LEVEL) + "px";

		if (finfo['n'])
		{
			var expander = document.createElement("span");
			expander.className = "tree_expander";

			var g_collapsed = webshark_glyph_img('collapsed', 16);
			g_collapsed.setAttribute('alt', 'Expand');
			g_collapsed.setAttribute('title', 'Click to expand');
			expander.appendChild(g_collapsed);

			var g_expanded = webshark_glyph_img('expanded', 16);
			g_expanded.setAttribute('alt', 'Collapse');
			g_expanded.setAttribute('title', 'Click to collapse');
			expander.appendChild(g_expanded);

			if (level == 1)
				proto_tree = finfo; /* XXX, verify */

			var subtree = webshark_create_proto_tree(finfo['n'], proto_tree, level + 1);
			ul.appendChild(subtree);

			li.insertBefore(expander, li.firstChild);

			var ett_expanded = false;
			if (finfo['e'] && sessionStorage.getItem("ett-" + finfo['e']) == '1')
				ett_expanded = true;

			li.data_ws_subtree = { ett: finfo['e'], expanded: ett_expanded, tree: subtree, exp: g_expanded, col: g_collapsed };

			webshark_tree_sync(li.data_ws_subtree);
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
	var d = webshark_create_proto_tree(tree, null, 1);

	dom_set_child(document.getElementById('ws_packet_detail_view'), d);
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

var webshark_host_fields_geo =
{
	'host': 'Address',
	'port': 'Port',
	'_packets' : 'Packets',
	'_bytes': 'Bytes',
	'txf': 'TX Packets',
	'txb': 'TX Bytes',
	'rxf': 'RX Packets',
	'rxb': 'RX Bytes',
	'geoip_country': 'GeoIP Country',
	'geoip_city': 'GeoIP City',
	'geoip_org': 'GeoIP ORG',
	'geoip_isp': 'GeoIP ISP',
	'geoip_as': 'GeoIP AS',
	'geoip_lat': 'GeoIP Lat',
	'geoip_lon': 'GeoIP Lon'
};

var webshark_eo_fields =
{
	'pkt': 'Packet number',
	'hostname': 'Hostname',
	'type': 'Content Type',
	'filename': 'Filename',
	'len': 'Length'
};

var webshark_rtp_streams_fields =
{
	'saddr': 'Src addr',
	'sport': 'Src port',
	'daddr': 'Dst addr',
	'dport': 'Dst port',
	'_ssrc': 'SSRC',
	'payload': 'Payload',
	'pkts':    'Packets',
	'_lost': 'Lost',
	'max_delta': 'Max Delta (ms)',
	'max_jitter': 'Max Jitter (ms)',
	'mean_jitter': 'Mean Jitter (ms)',
	'_pb': 'Pb?'
};


var webshark_rtd_fields =
{
	'n':       'Name',
	'num':     'Messages',
	'_min':    'Min SRT [ms]',
	'_max':    'Max SRT [ms]',
	'_avg':    'AVG SRT [ms]',
	'min_frame': 'Min in Frame',
	'max_frame': 'Max in Frame',
};

var webshark_srt_fields =
{
	'n':       'Procedure',
	'num':     'Calls',
	'_min':     'Min SRT [ms]',
	'_max':     'Max SRT [ms]',
	'_avg':    'Avg SRT [ms]'
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

var webshark_expert_fields =
{
	'f': 'No',
	's': 'Severity',
	'g': 'Group',
	'p': 'Protocol',
	'm': 'Summary'
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
	table.setAttribute('width', '100%');

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

		if (val['_css_class'])
		{
			tr.className = val['_css_class'];
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

		var glyph = webshark_glyph_img('filter', 16);
		glyph.setAttribute('alt', 'Filter: ' + data['_filter']);
		glyph.setAttribute('title', 'Filter: ' + data['_filter']);

		filter_a.appendChild(glyph);
		td.appendChild(filter_a);
	}

	if (data['_download'])
	{
		var down_a = document.createElement('a');

		down_a.setAttribute("target", "_blank");

		down_a.setAttribute("href", _webshark_url + 'req=download&capture=' + _webshark_file  + "&token=" + encodeURIComponent(data['_download']));
		down_a.addEventListener("click", popup_on_click_a);

		var glyph = webshark_glyph_img('download', 16);
		glyph.setAttribute('alt', 'Download: ' + data['_download']);
		glyph.setAttribute('title', 'Download: ' + data['_download']);

		down_a.appendChild(glyph);
		td.appendChild(down_a);
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
		var table = webshark_create_tap_table_common(webshark_stat_fields);

		webshark_create_tap_stat(table, tap['stats'], 0);

		document.getElementById('ws_tap_table').appendChild(dom_create_label("Stats TAP: " + tap['name']));
		document.getElementById('ws_tap_table').appendChild(table);

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		var g_stat = tap['stats'][0];

//		TODO: generate more graphs g_stat = g_stat['sub'][0];

		webshark_d3_chart(svg, g_stat['sub'],
		{
			title: g_stat['name'],
			mwidth: 800, iwidth: 50, height: 400,

			getX: function(d) { return d['name'] },

			unit1: '%',
			scale1: [ g_stat['count'] ],

			series1:
			[
				function(d) { return d['count']; }
			],

			color: [ 'steelblue' ]
		});

		document.getElementById('ws_tap_graph').appendChild(svg.node());
	}
	else if (tap['type'] == 'conv')
	{
		var table = webshark_create_tap_table_common(webshark_conv_fields);
		var convs = tap['convs'];

		for (var i = 0; i < convs.length; i++)
		{
			var conv = convs[i];

			if (conv['sport'])
			{
				conv['_sname'] = conv['saddr'] + ':' + conv['sport'];
				conv['_dname'] = conv['daddr'] + ':' + conv['dport'];
			}
			else
			{
				conv['_sname'] = conv['saddr'];
				conv['_dname'] = conv['daddr'];
			}

			conv['_name'] = conv['_sname'] + " <===>" + conv['_dname'];

			conv['_packets']  = conv['rxf'] + conv['txf'];
			conv['_bytes']    = conv['rxb'] + conv['txb'];
			conv['_duration'] = conv['stop'] - conv['start'];
			conv['_rate_tx'] = (8 * conv['txb']) / conv['_duration'];
			conv['_rate_rx'] = (8 * conv['rxb']) / conv['_duration'];

			conv['_filter'] = conv['filter'];
		}

		webshark_create_tap_table_data_common(webshark_conv_fields, table, convs);
		if (tap['geoip'] == true)
		{
			/* From http://dev.maxmind.com/geoip/geoip2/geolite2/ */
			var p = document.createElement('p');
			p.innerHTML = 'Webshark includes GeoLite2 data created by MaxMind, available from <a href="http://www.maxmind.com">http://www.maxmind.com</a>.';

			document.getElementById('ws_tap_table').appendChild(p);

			var link = "ipmap.html#" + window.btoa(JSON.stringify({'c': convs}));
			var iframe = document.createElement('iframe');
			iframe.frameBorder = 0;
			iframe.setAttribute("src", link);
			iframe.height = "100%";
			iframe.width = "100%";

			document.getElementById('ws_tap_extra').style.display = 'block';
			document.getElementById('ws_tap_extra').appendChild(iframe);
		}

		document.getElementById('ws_tap_table').appendChild(dom_create_label(tap['proto'] + ' Conversations (' + convs.length + ')'));
		document.getElementById('ws_tap_table').appendChild(table);

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, convs,
		{
			title: tap['proto'] + ' Conversations - Frames Count',
			mwidth: 500, iwidth: 25, height: 400,

			getX: function(d) { return d['_name']; },

			series2:
			[
				function(d) { return d['rxf']; },
				function(d) { return d['txf']; }
			],

			color: [ '#d62728', '#2ca02c' ],
			// color: [ '#e377c2', '#bcbd22' ],
		});

		document.getElementById('ws_tap_graph').appendChild(svg.node());

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, convs,
		{
			title: tap['proto'] + ' Conversations - Bytes Count',
			mwidth: 500, iwidth: 25, height: 400,

			getX: function(d) { return d['_name']; },

			series1:
			[
				function(d) { return d['rxb']; },
				function(d) { return d['txb']; }
			],

			color: [ '#d62728', '#2ca02c' ],
		});

		document.getElementById('ws_tap_graph').appendChild(svg.node());

	}
	else if (tap['type'] == 'host')
	{
		var host_fields = (tap['geoip'] == true) ? webshark_host_fields_geo : webshark_host_fields;

		var table = webshark_create_tap_table_common(host_fields);
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

		webshark_create_tap_table_data_common(host_fields, table, hosts);

		document.getElementById('ws_tap_table').appendChild(dom_create_label(tap['proto'] + ' Endpoints (' + hosts.length + ')'));
		if (tap['geoip'] == true)
		{
			/* From http://dev.maxmind.com/geoip/geoip2/geolite2/ */
			var p = document.createElement('p');
			p.innerHTML = 'Webshark includes GeoLite2 data created by MaxMind, available from <a href="http://www.maxmind.com">http://www.maxmind.com</a>.';

			document.getElementById('ws_tap_table').appendChild(p);

			var link = "ipmap.html#" + window.btoa(JSON.stringify({'h': hosts}));
			var iframe = document.createElement('iframe');
			iframe.frameBorder = 0;
			iframe.setAttribute("src", link);
			iframe.height = "100%";
			iframe.width = "100%";

			document.getElementById('ws_tap_extra').style.display = 'block';
			document.getElementById('ws_tap_extra').appendChild(iframe);
		}

		document.getElementById('ws_tap_table').appendChild(table);

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, hosts,
		{
			title: tap['proto'] + ' Endpoints - Frames Count',
			mwidth: 400, iwidth: 25, height: 400,

			getX: function(d) { return d['_name']; },

			series2:
			[
				function(d) { return d['rxf']; },
				function(d) { return d['txf']; }
			],

			color: [ '#d62728', '#2ca02c' ],
			// color: [ '#e377c2', '#bcbd22' ],
		});

		document.getElementById('ws_tap_graph').appendChild(svg.node());

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_chart(svg, hosts,
		{
			title: tap['proto'] + ' Endpoints - Bytes Count',
			mwidth: 400, iwidth: 25, height: 400,

			getX: function(d) { return d['_name']; },

			series1:
			[
				function(d) { return d['rxb']; },
				function(d) { return d['txb']; }
			],

			color: [ '#d62728', '#2ca02c' ],
		});

		document.getElementById('ws_tap_graph').appendChild(svg.node());
	}
	else if (tap['type'] == 'rtd')
	{
		var rtd_tables = tap['tables'];

		for (var i = 0; i < rtd_tables.length; i++)
		{
			var stats = rtd_tables[i]['stats'];

			var table = webshark_create_tap_table_common(webshark_rtd_fields);

			for (var j = 0; j < stats.length; j++)
			{
				var row = stats[j];

				row['_min'] = prec_trunc(100, row['min'] * 1000.0);
				row['_max'] = prec_trunc(100, row['max'] * 1000.0);
				row['_avg'] = prec_trunc(100, (row['tot'] / row['num']) * 1000.0);
			}

			webshark_create_tap_table_data_common(webshark_rtd_fields, table, stats);

			var rdiv = document.createElement('div');
			rdiv.appendChild(dom_create_label_span("Open Requests: " + rtd_tables[i]['open_req']));
			rdiv.appendChild(dom_create_label_span(", Discarded Responses: " + rtd_tables[i]['disc_rsp']));
			rdiv.appendChild(dom_create_label_span(", Repeated Requests: " + rtd_tables[i]['req_dup']));
			rdiv.appendChild(dom_create_label_span(", Repeated Responses: " + rtd_tables[i]['rsp_dup']));

			document.getElementById('ws_tap_table').appendChild(dom_create_label('Response Time Delay (' + tap['tap'] + ') ' + rtd_tables[i]['name']));
			document.getElementById('ws_tap_table').appendChild(rdiv);
			document.getElementById('ws_tap_table').appendChild(table);
		}

	}
	else if (tap['type'] == 'srt')
	{
		var srt_tables = tap['tables'];

		for (var i = 0; i < srt_tables.length; i++)
		{
			var rows = srt_tables[i]['r'];
			var filter = srt_tables[i]['f'];

			var table = webshark_create_tap_table_common(webshark_srt_fields);

			for (var j = 0; j < rows.length; j++)
			{
				var row = rows[j];

				row['_min'] = prec_trunc(100, row['min'] * 1000.0);
				row['_max'] = prec_trunc(100, row['max'] * 1000.0);
				row['_avg'] = prec_trunc(100, (row['tot'] / row['num']) * 1000);

				if (filter)
				{
					row['_filter'] = filter + ' == ' + row['idx'];
				}
			}

			webshark_create_tap_table_data_common(webshark_srt_fields, table, rows);

			document.getElementById('ws_tap_table').appendChild(dom_create_label('Service Response Time (' + tap['tap'] + ') ' + srt_tables[i]['n']));
			document.getElementById('ws_tap_table').appendChild(table);
		}
	}
	else if (tap['type'] == 'eo')
	{
		var table = webshark_create_tap_table_common(webshark_eo_fields);
		var objects = tap['objects'];

		webshark_create_tap_table_data_common(webshark_eo_fields, table, objects);

		document.getElementById('ws_tap_table').appendChild(dom_create_label("Export " + tap['proto'] + " object (" + objects.length + ')'));
		document.getElementById('ws_tap_table').appendChild(table);
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

		document.getElementById('ws_tap_table').appendChild(dom_create_label("VoIP calls (" + calls.length + ')'));
		document.getElementById('ws_tap_table').appendChild(table);
	}
	else if (tap['type'] == 'expert')
	{
		var table = webshark_create_tap_table_common(webshark_expert_fields);
		var details = tap['details'];

		for (var i = 0; i < details.length; i++)
		{
			var item = details[i];

			if (item['s'])
			{
				item['_css_class'] = 'ws_cell_expert_color_' + item['s'];
			}

			item['_filter'] = 'frame.number == ' + item['f'];
		}

		webshark_create_tap_table_data_common(webshark_expert_fields, table, details);

		document.getElementById('ws_tap_table').appendChild(dom_create_label("Expert information (" + details.length + ')'));
		document.getElementById('ws_tap_table').appendChild(table);
	}
	else if (tap['type'] == 'rtp-streams')
	{
		var table = webshark_create_tap_table_common(webshark_rtp_streams_fields);
		var streams = tap['streams'];

		for (var i = 0; i < streams.length; i++)
		{
			var stream = streams[i];

			stream['_ssrc'] = "0x" + xtoa(stream['ssrc'], 0);
			stream['_pb'] = stream['problem'] ? "X" : "";

			var lost = stream['expectednr'] - stream['totalnr'];

			stream['_lost'] = "" + lost + "(" + 100 * (lost / stream['expectednr']) + " %)";

			var ipstr = "ip";
			if (stream['ipver'] == 6) ipstr = "ipv6";

			stream['_filter'] = "(" + ipstr + ".src == " + stream['saddr'] + " && udp.srcport == " + stream['sport'] + " && " +
			                          ipstr + ".dst == " + stream['daddr'] + " && udp.dstport == " + stream['dport'] + " && " +
			                          "rtp.ssrc == " + stream['_ssrc'] +
			                    ")";
		}

		webshark_create_tap_table_data_common(webshark_rtp_streams_fields, table, streams);

		document.getElementById('ws_tap_table').appendChild(dom_create_label("RTP streams (" + streams.length + ')'));
		document.getElementById('ws_tap_table').appendChild(table);
	}
}

var _webshark_interval = null;
var _webshark_interval_filter = null;
var _webshark_interval_mode = "";

function webshark_render_interval()
{
	var intervals_data   = _webshark_interval ? _webshark_interval['intervals'] : null;
	var intervals_filter = _webshark_interval_filter ? _webshark_interval_filter['intervals'] : null;
	var intervals_full = [ ];

	var color_arr = [ 'steelblue' ];

	var count_idx =
		(_webshark_interval_mode == "bps") ? 2 :
		(_webshark_interval_mode == "fps") ? 1 :
		-1;

	if (count_idx == -1)
		return;

	for (var i = 0; i <= _webshark_interval['last']; i++)
		intervals_full[i] = [ i, 0, 0 ];

	if (intervals_data)
	{
		for (var i = 0; i < intervals_data.length; i++)
		{
			var idx = intervals_data[i][0];
			intervals_full[idx][1] += intervals_data[i][count_idx];
		}
	}

	if (intervals_filter)
	{
		for (var i = 0; i < intervals_filter.length; i++)
		{
			var idx = intervals_filter[i][0];
			intervals_full[idx][2] += intervals_filter[i][count_idx];
		}

		color_arr = [ '#ddd', 'steelblue' ]; /* grey out 'main interval', highlight 'filtered interval' */
	}

	/* TODO, put mark of current packet (_webshark_current_frame) */

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
			function(d) { return d[1]; },
			function(d) { return d[2]; }
		],

		color: color_arr
	});

	dom_set_child(document.getElementById('capture_interval'), svg.node());
}

var _webshark_files = [ ];

function webshark_display_files(filter)
{
	var files = _webshark_files;

	if (filter)
		files = files.filter(filter);

	_webshark_files_html.options.callbacks.createHTML = webshark_create_file_row_html;
	_webshark_files_html.setData(files);
}

function webshark_load_files()
{
	webshark_json_get('req=files',
		function(data)
		{
			var files = data['files'];

			files.sort(function(a, b)
			{
				var sta = a['status'], stb = b['status'];
				var ona, onb;

				ona = (sta && sta['online'] == true) ? 1 : 0;
				onb = (stb && stb['online'] == true) ? 1 : 0;

				/* first online */
				if (ona != onb)
					return ona < onb ? 1 : -1;

				/* and than by filename */
				return a['name'] > b['name'] ? 1 : -1;
			});

			_webshark_files = files;
			webshark_display_files();
		});
}

var _webshark_current_node = null;

function webshark_node_highlight_bytes(obj, node)
{
	/* unselect previous */
	if (_webshark_current_node != null)
		dom_remove_class(_webshark_current_node, "selected");

	var hls = [ ];

	var ds_idx = node['ds'];
	if (ds_idx == undefined)
		ds_idx = 0;

	if (node['h'] != undefined) /* highlight */
		hls.push({ tab: ds_idx, start: node['h'][0], end: (node['h'][0] + node['h'][1] ), style: 'selected_bytes' });

	if (node['i'] != undefined) /* appendix */
		hls.push({ tab: ds_idx, start: node['i'][0], end: (node['i'][0] + node['i'][1] ), style: 'selected_bytes' });

	if (node['p'] != undefined) /* protocol highlight */
	{
		var p_ds_idx = node['p_ds'];
		if (p_ds_idx == undefined)
			p_ds_idx = 0;

		hls.push({ tab: p_ds_idx, start: node['p'][0], end: (node['p'][0] + node['p'][1] ), style: 'selected_proto' });
	}

	var dom_tab = document.getElementById('ws_bytes' + ds_idx);
	if (dom_tab)
		dom_tab.click();

	_webshark_hexdump_html.active = ds_idx;
	_webshark_hexdump_html.highlights = hls;
	_webshark_hexdump_html.render_hexdump();

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
			var bytes_data = [ ];

			webshark_render_proto_tree(data['tree']);

			var fol = data['fol'];

			for (var i = 0; i < ws_follow.length; i++)
			{
				var it = document.getElementById('menu_tap_' + ws_follow[i].tap);

				if (it)
				{
					it.style.display = 'none';
				}
			}

			if (fol)
			{
				for (var i = 1; i < fol.length; i++)
				{
					var it = document.getElementById('menu_tap_follow:' + fol[i][0]);

					if (it)
					{
						it.setAttribute("href", window.location.href + "&follow=" + fol[i][0] + '&filter=' + fol[i][1]);
						it.style.display = 'inline';
					}
				}
			}

			bytes_data.push(window.atob(data['bytes']));

			/* multiple data sources? */
			var dom_ds = document.getElementById('ws_packet_pane');
			dom_ds.innerHTML = '';
			if (data['ds'])
			{
				var names = [ 'Frame (' + bytes_data[0].length + ' bytes)' ];

				for (var i = 0; i < data['ds'].length; i++)
				{
					names.push(data['ds'][i]['name']);
					bytes_data.push(window.atob(data['ds'][i]['bytes']));
				}

				/* TODO: tabs like in wireshark */
				for (var i = 0; i < names.length; i++)
				{
					var input = document.createElement('input');

					input.setAttribute('type', 'radio');
					input.setAttribute('id', 'ws_bytes' + i);
					input.setAttribute('name', 'ws_bytes');
					input.setAttribute('value', "" + i);
					if (i == 0)
						input.setAttribute('checked', 'checked');

					input.onchange = function()
					{
						var bytes_data = _webshark_hexdump_html.datas;

						_webshark_hexdump_html.active = this.value;
						_webshark_hexdump_html.render_hexdump();
					};

					dom_ds.appendChild(input);
					dom_ds.appendChild(document.createTextNode(names[i]));
				}
			}

			_webshark_hexdump_html.datas = bytes_data;
			_webshark_hexdump_html.active = 0;
			_webshark_hexdump_html.highlights = [ ];
			_webshark_hexdump_html.render_hexdump();

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

function webshark_load_follow(follow, filter)
{
	webshark_json_get('req=follow&capture=' + _webshark_file + '&follow=' + follow + '&filter=' + filter,
		function(data)
		{
			var f = data;
			var server_to_client_string = f['shost'] + ':' + f['sport'] + ' --> ' + f['chost'] + ':' + f['cport'] + ' (' + f['sbytes'] + ' bytes)';
			var client_to_server_string = f['chost'] + ':' + f['cport'] + ' --> ' + f['shost'] + ':' + f['sport'] + ' (' + f['cbytes'] + ' bytes)';

			var div = document.createElement('div');

			if (f['payloads'])
			{
				var p = f['payloads'];

				for (var i = 0; i < p.length; i++)
				{
					var pre = document.createElement('pre');

					pre.className = (p[i]['s'] != undefined) ? 'follow_server_tag' : 'follow_client_tag';

					pre.innerHTML = window.atob(p[i]['d']);

					div.appendChild(pre);
				}
			}

			document.getElementById('ws_tap_table').appendChild(div);

		});
}
