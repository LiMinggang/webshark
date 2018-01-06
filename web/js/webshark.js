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

var m_webshark_capture_files_module = require("./webshark-capture-files.js");
var m_webshark_display_filter_module = require('./webshark-display-filter.js');
var m_webshark_packet_list_module = require("./webshark-packet-list.js");
var m_webshark_protocol_tree_module = require("./webshark-protocol-tree.js");
var m_webshark_hexdump_module = require('./webshark-hexdump.js');
var m_webshark_interval_module = require("./webshark-interval.js");
var m_webshark_preferences_module = require("./webshark-preferences.js");
var m_webshark_tap_module = require("./webshark-tap.js");
var m_webshark_symbols_module = require("./webshark-symbols.js");

var m_webshark_current_frame = 0;

function Webshark()
{
	this.status = null;
	this.cols = null;
	this.filter = null;

	this.fetch_columns_limit = 120;

	this.ref_frames = [ ];
	this.cached_columns = [ ];
}

Webshark.prototype.load = function(filename, cb)
{
	var req_status =
		{
			req: 'status',
			capture: filename
		};

	var that = this;

	webshark_json_get(req_status,
		function(data)
		{
			data['filename'] = filename; /* we know better */

			that.status = data;
			cb(data);
		});
};

Webshark.prototype.setRefFrame = function(framenum, is_ref)
{
	var done = false;

	for (var i = 0; i < this.ref_frames.length; i++)
	{
		var ref_frame = this.ref_frames[i];

		if (ref_frame == framenum)
		{
			this.ref_frames[i] = (is_ref) ? framenum : 0;
			done = true;
			break;
		}

		if (ref_frame == 0 && is_ref)
		{
			this.ref_frames[i] = framenum;
			done = true;
			break;
		}
	}

	if (!done && is_ref)
	{
		this.ref_frames.push(framenum);
	}

	this.ref_frames.sort(function(a, b)
	{
		return a - b;
	});

	this.invalidCacheFrames();
};

Webshark.prototype.getCurrentFrameNumber = function()
{
	return m_webshark_current_frame;
};

Webshark.prototype.getRefFrame = function(framenum)
{
	var max_ref_frame = 0;

	for (var i = 0; i < this.ref_frames.length; i++)
	{
		var ref_frame = this.ref_frames[i];

		/* skip ref frames bigger than requested frame number */
		if (ref_frame > framenum)
			continue;

		if (max_ref_frame < ref_frame)
			max_ref_frame = ref_frame;
	}

	return max_ref_frame;
};

Webshark.prototype.getRefFrames = function()
{
	var str = "";
	var sepa = "";

	for (var i = 0; i < this.ref_frames.length; i++)
	{
		var ref_frame = this.ref_frames[i];

		if (!ref_frame)
			continue;

		str = str + sepa + ref_frame;
		sepa = ",";
	}

	return str;
};

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
	var req_intervals =
		{
			req: 'intervals',
			capture: g_webshark_file
		};

	if (this.filter)
		req_intervals['filter'] = this.filter;

	/* XXX, webshark.load() is not called for taps/ single frames/ ... */
	if (g_webshark_interval && this.status)
	{
		g_webshark_interval.setDuration(this.status.duration);
		req_intervals['interval'] = 1000 * g_webshark_interval.getScale();
	}
	else
	{
		req_intervals['interval'] = 1000 * 60 * 60 * 24;  /* XXX, if interval is not created we don't really care about result data. There is no easy way to get information about number of frames after filtering ;( */
	}

	var that = this;

	/* XXX, first need to download intervals to know how many rows we have, rewrite */
	webshark_json_get(req_intervals,
		function(data)
		{
			if (g_webshark_interval && that.status)
				g_webshark_interval.setResult(that.filter, data);

			that.cached_columns = [ ];
			that.cached_columns.length = data['frames'];
			that.fetchColumns(0, true);
		});
};

Webshark.prototype.fetchColumns = function(skip, load_first)
{
	var req_frames =
		{
			req: 'frames',
			capture: g_webshark_file
		};

	if (this.fetch_columns_limit != 0)
		req_frames['limit'] = this.fetch_columns_limit;

	if (skip != 0)
		req_frames['skip'] = skip;

	if (this.filter)
		req_frames['filter'] = this.filter;

	for (var i = 0; i < this.fetch_columns_limit && skip + i < this.cached_columns.length; i++)
	{
		if (!this.cached_columns[skip + i])
			this.cached_columns[skip + i] = m_webshark_packet_list_module.m_COLUMN_DOWNLOADING;
	}

	if (this.cols)
	{
		for (var i = 0; i < this.cols.length; i++)
			req_frames['column' + i] = this.cols[i];
	}

	var refs = this.getRefFrames();
	if (refs != "")
		req_frames['refs'] = refs;

	var that = this;

	webshark_json_get(req_frames,
		function(data)
		{
			if (data)
			{
				for (var i = 0; i < data.length; i++)
					that.cached_columns[skip + i] = data[i];
				g_webshark_packet_list.setPackets(that.cached_columns);
			}

			if (load_first && data && data[0])
			{
				var framenum = data[0].num;
				webshark_load_frame(framenum, false);
			}
		});
};

Webshark.prototype.invalidCacheFrames = function()
{
	for (var i = 0; i < this.cached_columns.length; i++)
	{
		this.cached_columns[i] = null;
	}

	g_webshark_packet_list.setPackets(this.cached_columns);
};

Webshark.prototype.invalidCacheFrame = function(framenum)
{
	for (var i = 0; i < this.cached_columns.length; i++)
	{
		if (this.cached_columns[i])
		{
			var cur_framenum = this.cached_columns[i].num;

			if (framenum == cur_framenum)
			{
				this.cached_columns[i] = null;
				this.fetchColumns(i, false);
				return;
			}
		}
	}
};

Webshark.prototype.getComment = function(framenum, func)
{
	webshark_json_get(
		{
			req: 'frame',
			capture: g_webshark_file,
			frame: framenum
		},
		func);
};

Webshark.prototype.setComment = function(framenum, new_comment)
{
	var set_req =
		{
			req: 'setcomment',
			capture: g_webshark_file,
			frame: framenum
		};

	if (new_comment != null && new_comment != "")
	{
		/* NULL or empty comment, means delete comment */
		set_req['comment'] = new_comment;
	}

	var that = this;

	webshark_json_get(set_req,
		function(data)
		{
			/* XXX, lazy, need invalidate cache, to show comment symbol, FIX (notifications?) */
			that.invalidCacheFrame(framenum);

			if (m_webshark_current_frame == framenum)
			{
				m_webshark_current_frame = 0;
				webshark_load_frame(framenum, false);
			}
		});
};

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

function webshark_get_base_url()
{
	var base_url = window.location.href.split("?")[0];

	return base_url;
}

function webshark_get_url()
{
	var base_url = window.location.href.split("?")[0];

	var extra = '?file=' + g_webshark_file;

	return base_url + extra;
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

function dom_clear(p)
{
	p.innerHTML = "";
}

function dom_set_child(p, ch)
{
	dom_clear(p);
	p.appendChild(ch);
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

function webshark_json_get(req_data, cb)
{
	var http = new XMLHttpRequest();

	var req = null;

	for (var r in req_data)
	{
		var creq = r + "=" + encodeURIComponent(req_data[r]);

		if (req)
			req = req + "&" + creq;
		else
			req = creq;
	}

	debug(3, " webshark_json_get(" + req + ") sending request");

	http.open("GET", g_webshark_url + req, true);
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

function webshark_frame_comment_on_over(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (node != null)
	{
		var framenum = node.data_ws_frame;

		g_webshark.getComment(framenum,
			function(data)
			{
				var tgt = ev.target;
				if (tgt)
				{
					var frame_comment = data['comment'];

					if (frame_comment)
					{
						tgt.setAttribute('alt', 'Edit Comment: ' + frame_comment);
						tgt.setAttribute('title', 'Edit Comment: ' + frame_comment);
					}
					else
					{
						tgt.setAttribute('alt', 'New Comment');
						tgt.setAttribute('title', 'New Comment');
					}
				}
			});
	}

	ev.preventDefault();
}

function webshark_frame_timeref_on_click(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (node != null)
	{
		var framenum = node.data_ws_frame;
		var timeref = (g_webshark.getRefFrame(framenum) == framenum);

		g_webshark.setRefFrame(framenum, !timeref);
	}

	ev.preventDefault();
}

function webshark_frame_comment_on_click(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (node != null)
	{
		var framenum = node.data_ws_frame;

		g_webshark.getComment(framenum,
			function(data)
			{
				var prev_comment = data['comment'];

				var comment = window.prompt("Please enter new comment for frame #" + framenum, prev_comment);
				if (comment != null)
					g_webshark.setComment(framenum, comment);
			});
	}

	ev.preventDefault();
}

function webshark_frame_goto(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (node != null)
	{
		webshark_load_frame(node.data_ws_frame, true);
	}

	ev.preventDefault();
}

function webshark_hexump_switch_tab(new_active, do_render)
{
	var prev_active = g_webshark_hexdump_html.active;
	var btn;

	if (prev_active == new_active)
		return;

	g_webshark_hexdump_html.active = new_active;
	if (do_render)
		g_webshark_hexdump_html.render_hexdump();


	btn = document.getElementById('ws_bytes' + prev_active);
	if (btn)
		btn.classList.remove('selected');

	btn = document.getElementById('ws_bytes' + new_active);
	if (btn)
		btn.classList.add('selected');
}

function webshark_on_field_select_highlight_bytes(node)
{
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

	webshark_hexump_switch_tab(ds_idx, false);

	g_webshark_hexdump_html.active = ds_idx;
	g_webshark_hexdump_html.highlights = hls;
	g_webshark_hexdump_html.render_hexdump();
}

function webshark_load_frame(framenum, scroll_to, cols)
{
	/* frame content should not change -> skip requests for frame like current one */
	if (framenum == m_webshark_current_frame)
		return;

	/* unselect previous */
	if (m_webshark_current_frame != 0)
	{
		var obj = document.getElementById('packet-list-frame-' + m_webshark_current_frame);
		if (obj)
			obj.classList.remove("selected");
	}

	var load_req =
		{
			req: 'frame',
			bytes: 'yes',
			proto: 'yes',
			capture: g_webshark_file,
			frame: framenum
		};

	var ref_framenum = g_webshark.getRefFrame(framenum);
	if (ref_framenum)
		load_req['ref_frame'] = ref_framenum;
	load_req['prev_frame'] = framenum - 1;   /* TODO */

	webshark_json_get(load_req,
		function(data)
		{
			var bytes_data = [ ];

			g_webshark_prototree_html.onFieldSelect = webshark_on_field_select_highlight_bytes;
			g_webshark_prototree_html.tree = data['tree'];
			g_webshark_prototree_html.render_tree();

			var fol = data['fol'];

			for (var i = 0; i < g_ws_follow.length; i++)
			{
				var it = document.getElementById('menu_tap_' + g_ws_follow[i].tap);

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

				for (var i = 0; i < names.length; i++)
				{
					var btn = document.createElement('button');

					btn.setAttribute('id', 'ws_bytes' + i);
					btn.className = 'wsbutton';
					if (i == 0)
						btn.classList.add('selected');

					btn.addEventListener("click", webshark_hexump_switch_tab.bind(null, i, true));

					btn.appendChild(document.createTextNode(names[i]));
					dom_ds.appendChild(btn);
				}
			}

			g_webshark_hexdump_html.datas = bytes_data;
			g_webshark_hexdump_html.active = 0;
			g_webshark_hexdump_html.highlights = [ ];
			g_webshark_hexdump_html.render_hexdump();

			if (g_webshark_on_frame_change != null)
			{
				g_webshark_on_frame_change(framenum, data);
			}

			m_webshark_current_frame = framenum;

			/* select new */
			var obj = document.getElementById('packet-list-frame-' + framenum);
			if (obj)
			{
				obj.classList.add('selected');
				if (scroll_to)
					obj.scrollIntoView(false);
			}

		});
}

function webshark_load_follow(follow, filter)
{
	webshark_json_get(
		{
			req: 'follow',
			capture: g_webshark_file,
			follow: follow,
			filter: filter
		},
		function(data)
		{
			var f = data;
			var server_to_client_string_tag = f['shost'] + ':' + f['sport'] + ' --> ' + f['chost'] + ':' + f['cport'];
			var client_to_server_string_tag = f['chost'] + ':' + f['cport'] + ' --> ' + f['shost'] + ':' + f['sport'];

			var server_to_client_string = server_to_client_string_tag + ' (' + f['sbytes'] + ' bytes)';
			var client_to_server_string = client_to_server_string_tag + ' (' + f['cbytes'] + ' bytes)';

			var div = document.createElement('div');

			if (f['payloads'])
			{
				var p = f['payloads'];

				for (var i = 0; i < p.length; i++)
				{
					var f_txt = window.atob(p[i]['d']);
					var f_no = p[i]['n'];
					var f_server = (p[i]['s'] != undefined);

					var load_frame_func = webshark_load_frame.bind(null, f_no, true);

					var pre = document.createElement('pre');
					pre.appendChild(document.createTextNode('Frame #' + f_no + ': ' + (f_server ? server_to_client_string_tag : client_to_server_string_tag) +' (' + f_txt.length+ ' bytes)'));
					pre.className = 'follow_frame_no';
					pre.addEventListener("click", load_frame_func);
					div.appendChild(pre);

					var pre = document.createElement('pre');
					pre.appendChild(document.createTextNode(f_txt));
					pre.className = f_server ? 'follow_server_tag' : 'follow_client_tag';
					pre.addEventListener("click", load_frame_func);
					div.appendChild(pre);
				}
			}

			document.getElementById('ws_tap_table').appendChild(div);

			document.getElementById('ws_packet_list_view').style.display = 'block';
			g_webshark.setFilter(filter);

		});
}

exports.ProtocolTree = m_webshark_protocol_tree_module.ProtocolTree;
exports.Hexdump = m_webshark_hexdump_module.Hexdump;
exports.WSCaptureFilesTable = m_webshark_capture_files_module.WSCaptureFilesTable;
exports.WSDisplayFilter = m_webshark_display_filter_module.WSDisplayFilter;
exports.WSInterval = m_webshark_interval_module.WSInterval;
exports.WSPacketList = m_webshark_packet_list_module.WSPacketList;
exports.WSPreferencesTable = m_webshark_preferences_module.WSPreferencesTable;
exports.webshark_load_tap = m_webshark_tap_module.webshark_load_tap;
exports.webshark_create_file_details = m_webshark_capture_files_module.webshark_create_file_details;
exports.webshark_glyph_img = m_webshark_symbols_module.webshark_glyph_img;

exports.Webshark = Webshark;
exports.webshark_json_get = webshark_json_get;

exports.webshark_get_base_url = webshark_get_base_url;
exports.webshark_get_url = webshark_get_url;
exports.webshark_frame_goto = webshark_frame_goto;
exports.webshark_load_frame = webshark_load_frame;
exports.popup_on_click_a = popup_on_click_a;

exports.dom_create_label = dom_create_label;
exports.dom_set_child = dom_set_child;
exports.dom_find_node_attr = dom_find_node_attr;

exports.webshark_d3_chart = webshark_d3_chart;

exports.webshark_load_follow = webshark_load_follow;
exports.webshark_frame_comment_on_over = webshark_frame_comment_on_over;
exports.webshark_frame_timeref_on_click = webshark_frame_timeref_on_click;
exports.webshark_frame_comment_on_click = webshark_frame_comment_on_click;
