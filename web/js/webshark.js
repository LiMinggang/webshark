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
var m_webshark_protocol_tree_module = require("./webshark-protocol-tree.js");
var m_webshark_hexdump_module = require('./webshark-hexdump.js');
var m_webshark_tap_module = require("./webshark-tap.js");

var m_COLUMN_DOWNLOADING = 42;

var m_webshark_interval = null;
var m_webshark_interval_scale = null;
var m_webshark_interval_filter = null;

var m_glyph_cache = { };
var m_webshark_current_frame = null;

function Webshark()
{
	this.status = null;
	this.cols = null;
	this.filter = null;

	this.fetch_columns_limit = 120;
	this.interval_count = 620; /* XXX, number of probes - currently size of svg */

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
	if (this.status)
	{
		m_webshark_interval_scale = Math.round(this.status.duration / this.interval_count);
		if (m_webshark_interval_scale < 1)
			m_webshark_interval_scale = 1;
		req_intervals['interval'] = 1000 * m_webshark_interval_scale;
	}

	var that = this;

	/* XXX, first need to download intervals to know how many rows we have, rewrite */
	webshark_json_get(req_intervals,
		function(data)
		{
			if (that.filter)
			{
				m_webshark_interval_filter = data;
			}
			else
			{
				m_webshark_interval = data;
				m_webshark_interval_filter = null; /* render only main */
			}

			/* XXX, broken */
			try {
				webshark_render_interval();
			} catch(ex) { }

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
			this.cached_columns[skip + i] = m_COLUMN_DOWNLOADING;
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
				webshark_lazy_frames(that.cached_columns);
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

	webshark_lazy_frames(this.cached_columns);
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
				m_webshark_current_frame = null;
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

function webshark_glyph(what)
{
	if (m_glyph_cache[what])
		return m_glyph_cache[what];

	var fa_paths =
	{
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/eye.svg */
		'analyse': "M1664 960q-152-236-381-353 61 104 61 225 0 185-131.5 316.5t-316.5 131.5-316.5-131.5-131.5-316.5q0-121 61-225-229 117-381 353 133 205 333.5 326.5t434.5 121.5 434.5-121.5 333.5-326.5zm-720-384q0-20-14-34t-34-14q-125 0-214.5 89.5t-89.5 214.5q0 20 14 34t34 14 34-14 14-34q0-86 61-147t147-61q20 0 34-14t14-34zm848 384q0 34-20 69-140 230-376.5 368.5t-499.5 138.5-499.5-139-376.5-368q-20-35-20-69t20-69q140-229 376.5-368t499.5-139 499.5 139 376.5 368q20 35 20 69z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/comment-o.svg */
		'comment': 'M896 384q-204 0-381.5 69.5t-282 187.5-104.5 255q0 112 71.5 213.5t201.5 175.5l87 50-27 96q-24 91-70 172 152-63 275-171l43-38 57 6q69 8 130 8 204 0 381.5-69.5t282-187.5 104.5-255-104.5-255-282-187.5-381.5-69.5zm896 512q0 174-120 321.5t-326 233-450 85.5q-70 0-145-8-198 175-460 242-49 14-114 22h-5q-15 0-27-10.5t-16-27.5v-1q-3-4-.5-12t2-10 4.5-9.5l6-9 7-8.5 8-9q7-8 31-34.5t34.5-38 31-39.5 32.5-51 27-59 26-76q-157-89-247.5-220t-90.5-281q0-174 120-321.5t326-233 450-85.5 450 85.5 326 233 120 321.5z',
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/clock-o.svg */
		'timeref': 'M1024 544v448q0 14-9 23t-23 9h-320q-14 0-23-9t-9-23v-64q0-14 9-23t23-9h224v-352q0-14 9-23t23-9h64q14 0 23 9t9 23zm416 352q0-148-73-273t-198-198-273-73-273 73-198 198-73 273 73 273 198 198 273 73 273-73 198-198 73-273zm224 0q0 209-103 385.5t-279.5 279.5-385.5 103-385.5-103-279.5-279.5-103-385.5 103-385.5 279.5-279.5 385.5-103 385.5 103 279.5 279.5 103 385.5z',
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/caret-right.svg */
		'collapsed': "M1152 896q0 26-19 45l-448 448q-19 19-45 19t-45-19-19-45v-896q0-26 19-45t45-19 45 19l448 448q19 19 19 45z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/caret-down.svg */
		'expanded': "M1408 704q0 26-19 45l-448 448q-19 19-45 19t-45-19l-448-448q-19-19-19-45t19-45 45-19h896q26 0 45 19t19 45z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/filter.svg */
		'filter': "M1595 295q17 41-14 70l-493 493v742q0 42-39 59-13 5-25 5-27 0-45-19l-256-256q-19-19-19-45v-486l-493-493q-31-29-14-70 17-39 59-39h1280q42 0 59 39z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/files-o.svg */
		'files': "M1696 384q40 0 68 28t28 68v1216q0 40-28 68t-68 28h-960q-40 0-68-28t-28-68v-288h-544q-40 0-68-28t-28-68v-672q0-40 20-88t48-76l408-408q28-28 76-48t88-20h416q40 0 68 28t28 68v328q68-40 128-40h416zm-544 213l-299 299h299v-299zm-640-384l-299 299h299v-299zm196 647l316-316v-416h-384v416q0 40-28 68t-68 28h-416v640h512v-256q0-40 20-88t48-76zm956 804v-1152h-384v416q0 40-28 68t-68 28h-416v640h896z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/folder-o.svg */
		'folder': "M1600 1312v-704q0-40-28-68t-68-28h-704q-40 0-68-28t-28-68v-64q0-40-28-68t-68-28h-320q-40 0-68 28t-28 68v960q0 40 28 68t68 28h1216q40 0 68-28t28-68zm128-704v704q0 92-66 158t-158 66h-1216q-92 0-158-66t-66-158v-960q0-92 66-158t158-66h320q92 0 158 66t66 158v32h672q92 0 158 66t66 158z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/folder-open-o.svg */
		'pfolder': "M1845 931q0-35-53-35h-1088q-40 0-85.5 21.5t-71.5 52.5l-294 363q-18 24-18 40 0 35 53 35h1088q40 0 86-22t71-53l294-363q18-22 18-39zm-1141-163h768v-160q0-40-28-68t-68-28h-576q-40 0-68-28t-28-68v-64q0-40-28-68t-68-28h-320q-40 0-68 28t-28 68v853l256-315q44-53 116-87.5t140-34.5zm1269 163q0 62-46 120l-295 363q-43 53-116 87.5t-140 34.5h-1088q-92 0-158-66t-66-158v-960q0-92 66-158t158-66h320q92 0 158 66t66 158v32h544q92 0 158 66t66 158v160h192q54 0 99 24.5t67 70.5q15 32 15 68z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/play.svg */
		'play': "M1576 927l-1328 738q-23 13-39.5 3t-16.5-36v-1472q0-26 16.5-36t39.5 3l1328 738q23 13 23 31t-23 31z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/stop.svg */
		'stop': "M1664 192v1408q0 26-19 45t-45 19h-1408q-26 0-45-19t-19-45v-1408q0-26 19-45t45-19h1408q26 0 45 19t19 45z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/upload.svg */
		'upload': "M1344 1472q0-26-19-45t-45-19-45 19-19 45 19 45 45 19 45-19 19-45zm256 0q0-26-19-45t-45-19-45 19-19 45 19 45 45 19 45-19 19-45zm128-224v320q0 40-28 68t-68 28h-1472q-40 0-68-28t-28-68v-320q0-40 28-68t68-28h427q21 56 70.5 92t110.5 36h256q61 0 110.5-36t70.5-92h427q40 0 68 28t28 68zm-325-648q-17 40-59 40h-256v448q0 26-19 45t-45 19h-256q-26 0-45-19t-19-45v-448h-256q-42 0-59-40-17-39 14-69l448-448q18-19 45-19t45 19l448 448q31 30 14 69z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/download.svg */
		'download': "M1344 1344q0-26-19-45t-45-19-45 19-19 45 19 45 45 19 45-19 19-45zm256 0q0-26-19-45t-45-19-45 19-19 45 19 45 45 19 45-19 19-45zm128-224v320q0 40-28 68t-68 28h-1472q-40 0-68-28t-28-68v-320q0-40 28-68t68-28h465l135 136q58 56 136 56t136-56l136-136h464q40 0 68 28t28 68zm-325-569q17 41-14 70l-448 448q-18 19-45 19t-45-19l-448-448q-31-29-14-70 17-39 59-39h256v-448q0-26 19-45t45-19h256q26 0 45 19t19 45v448h256q42 0 59 39z"
	};

	var svg;
	switch (what)
	{
		case 'analyse':
		case 'comment':
		case 'timeref':
		case 'collapsed':
		case 'expanded':
		case 'filter':
		case 'files':
		case 'folder':
		case 'pfolder':
		case 'play':
		case 'stop':
		case 'upload':
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
	m_glyph_cache[what] = str;
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
		webshark_load_frame(frame_node.data_ws_frame, false);
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
		webshark_load_frame(node.data_ws_frame, true);
	}

	ev.preventDefault();
}

function webshark_create_frame_row_html(frame, row_no)
{
	var tr = document.createElement("tr");

	if (!frame)
	{
		g_webshark.fetchColumns(row_no, false);
		return tr;
	}

	if (frame == m_COLUMN_DOWNLOADING)
		return tr;

	var cols = frame['c'];
	var fnum = frame['num'];

	for (var j = 0; j < cols.length; j++)
	{
		var td = document.createElement("td");

td.width = Math.floor(1000 / cols.length) + "px"; // XXX, temporary

		if (j == 0)
		{
			/* XXX, check if first column is equal to frame number, if so assume it's frame number column, and create link */
			if (cols[0] == fnum)
			{
				var a = document.createElement('a');

				a.appendChild(document.createTextNode(cols[j]))

				a.setAttribute("target", "_blank");
				a.setAttribute("href", webshark_get_url() + "&frame=" + fnum);
				a.addEventListener("click", webshark_frame_on_click);

				td.appendChild(a);
			}

			if (frame['ct'])
			{
				var a = document.createElement('a');

				var comment_glyph = webshark_glyph_img('comment', 14);
				comment_glyph.setAttribute('alt', 'Comment');
				comment_glyph.setAttribute('title', 'Comment');

				a.setAttribute("target", "_blank");
				a.setAttribute("href", webshark_get_url() + "&frame=" + fnum);
				a.addEventListener("click", webshark_frame_comment_on_click);
				a.addEventListener("mouseover", webshark_frame_comment_on_over);

				a.appendChild(comment_glyph);
				td.appendChild(a);
			}
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

	if (fnum == m_webshark_current_frame)
		tr.classList.add('selected');

	tr.id = 'packet-list-frame-' + fnum;
	tr.data_ws_frame = fnum;
	tr.addEventListener("click", webshark_frame_row_on_click);

	return tr;
}

function webshark_lazy_frames(frames)
{
	g_webshark_frames_html.options.callbacks.createHTML = webshark_create_frame_row_html;

	// don't work g_webshark_frames_html.scroll_elem.scrollTop = 0;
	g_webshark_frames_html.setData(frames);
}

function webshark_render_interval()
{
	var intervals_data   = m_webshark_interval ? m_webshark_interval['intervals'] : null;
	var intervals_filter = m_webshark_interval_filter ? m_webshark_interval_filter['intervals'] : null;
	var intervals_full = [ ];

	var last_one  = m_webshark_interval ? m_webshark_interval['last'] : m_webshark_interval_filter['last'];
	var color_arr = [ 'steelblue' ];

	var count_idx =
		(g_webshark_interval_mode == "bps") ? 2 :
		(g_webshark_interval_mode == "fps") ? 1 :
		-1;

	if (count_idx == -1)
		return;

	for (var i = 0; i <= last_one; i++)
		intervals_full[i] = [ (i * m_webshark_interval_scale), 0, 0 ];

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

	/* TODO, put mark of current packet (m_webshark_current_frame) */

	var svg = d3.select("body").append("svg").remove();

	webshark_d3_chart(svg, intervals_full,
	{
		width: 620, height: 100,
		margin: {top: 0, right: 10, bottom: 20, left: 40},

		xrange: [ 0, (last_one * m_webshark_interval_scale) ],

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

	var dom_tab = document.getElementById('ws_bytes' + ds_idx);
	if (dom_tab)
		dom_tab.click();

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
	if (m_webshark_current_frame != null)
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
						var bytes_data = g_webshark_hexdump_html.datas;

						g_webshark_hexdump_html.active = this.value;
						g_webshark_hexdump_html.render_hexdump();
					};

					dom_ds.appendChild(input);
					dom_ds.appendChild(document.createTextNode(names[i]));
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

					var pre = document.createElement('pre');
					pre.appendChild(document.createTextNode('Frame #' + f_no + ': ' + (f_server ? server_to_client_string_tag : client_to_server_string_tag) +' (' + f_txt.length+ ' bytes)'));
					pre.className = 'follow_frame_no';
					pre.data_ws_frame = f_no;
					pre.addEventListener("click", webshark_frame_goto);
					div.appendChild(pre);

					var pre = document.createElement('pre');
					pre.appendChild(document.createTextNode(f_txt));
					pre.className = f_server ? 'follow_server_tag' : 'follow_client_tag';
					pre.data_ws_frame = f_no;
					pre.addEventListener("click", webshark_frame_goto);
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
exports.webshark_load_tap = m_webshark_tap_module.webshark_load_tap;
exports.webshark_create_file_details = m_webshark_capture_files_module.webshark_create_file_details;

exports.Webshark = Webshark;
exports.webshark_json_get = webshark_json_get;
exports.webshark_glyph_img = webshark_glyph_img;

exports.webshark_get_base_url = webshark_get_base_url;
exports.webshark_get_url = webshark_get_url;
exports.webshark_frame_goto = webshark_frame_goto;
exports.popup = popup;
exports.popup_on_click_a = popup_on_click_a;

exports.dom_create_label = dom_create_label;
exports.dom_set_child = dom_set_child;
exports.dom_find_node_attr = dom_find_node_attr;

exports.webshark_render_columns = webshark_render_columns;
exports.webshark_render_interval = webshark_render_interval;
exports.webshark_d3_chart = webshark_d3_chart;

exports.webshark_load_follow = webshark_load_follow;
exports.webshark_frame_comment_on_over = webshark_frame_comment_on_over;
exports.webshark_frame_timeref_on_click = webshark_frame_timeref_on_click;
exports.webshark_frame_comment_on_click = webshark_frame_comment_on_click;
