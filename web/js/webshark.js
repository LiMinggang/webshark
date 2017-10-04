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

var _webshark_on_frame_change = null;

var _webshark_files_html = null;
var _webshark_frames_html = null;
var _webshark_hexdump_html = null;

var _webshark = null;
var _webshark_rtps_players = { };
var _webshark_rtps_players_name = { };
var _webshark_rtps_table = { };

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

			str_ascii += ch_escape(chtoa(ch));

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
	this.status = null;
	this.cols = null;
	this.filter = null;
	this.field_filter = null;

	this.fetch_columns_limit = 120;
	this.interval_count = 620; /* XXX, number of probes - currently size of svg */

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
			capture: _webshark_file
		};

	if (this.filter)
		req_intervals['filter'] = this.filter;

	/* XXX, webshark.load() is not called for taps/ single frames/ ... */
	if (this.status)
	{
		_webshark_interval_scale = Math.round(this.status.duration / this.interval_count);
		if (_webshark_interval_scale < 1)
			_webshark_interval_scale = 1;
		req_intervals['interval'] = 1000 * _webshark_interval_scale;
	}

	var that = this;

	/* XXX, first need to download intervals to know how many rows we have, rewrite */
	webshark_json_get(req_intervals,
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
			that.fetchColumns(0, true);
		});
};

Webshark.prototype.fetchColumns = function(skip, load_first)
{
	var req_frames =
		{
			req: 'frames',
			capture: _webshark_file
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
			this.cached_columns[skip + i] = column_downloading;
	}

	if (this.cols)
	{
		for (var i = 0; i < this.cols.length; i++)
			req_frames['column' + i] = this.cols[i];
	}

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
			capture: _webshark_file,
			frame: framenum
		},
		func);
};

Webshark.prototype.setComment = function(framenum, new_comment)
{
	var set_req =
		{
			req: 'setcomment',
			capture: _webshark_file,
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

			if (_webshark_current_frame == framenum)
			{
				_webshark_current_frame = null;
				webshark_load_frame(framenum, false);
			}
		});
};

Webshark.prototype.checkFieldFilter = function(finfo)
{
	if (this.field_filter == null)
		return true;

	var x = this.field_filter;
	if (finfo['f'] && finfo['f'].indexOf(x) != -1)
		return true;

	if (finfo['l'] && finfo['l'].indexOf(x) != -1)
		return true;

	var subtree = finfo['n'];
	if (subtree)
	{
		for (var i = 0; i < subtree.length; i++)
			if (this.checkFieldFilter(subtree[i]))
				return true;
	}

	return false;
};

Webshark.prototype.setFieldFilter = function(new_filter)
{
	this.field_filter = new_filter;

	webshark_render_proto_tree(_webshark_current_frame_tree);
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

function player_find_index(tap, ts)
{
	// TODO, optimize with binary search

	for (var i = 0; i < tap.length; i++)
	{
		var off = tap[i]['o'];

		if (off >= ts)
			return i;
	}

	return -1;
}

function player_sync_view(x, ts)
{
	var t = _webshark_rtps_table[x];

	if (t)
	{
		var items = t[0];
		var table = t[1];
		var prev_node = t[2];

		if (prev_node)
			dom_remove_class(prev_node, "selected");

		var idx = player_find_index(items, ts);
		if (idx != -1)
		{
			var current_node = table.childNodes[1 + idx];
			dom_add_class(current_node, "selected");
			current_node.scrollIntoView(false);

			t[2] = current_node;
		}
	}
}

function play_on_click_a(ev)
{
	var node;
	var url;

	node = dom_find_node_attr(ev.target, 'href');
	if (node != null)
	{
		url = node['href'];
		if (url != null)
		{
			var wavesurfer = _webshark_rtps_players[url];

			if (wavesurfer)
			{
				wavesurfer.play();
				ev.preventDefault();
				return;
			}

			var div = document.createElement('div');
			{
				var pdiv = document.getElementById('ws_rtp_playback');
				var s = new Date().getTime();
				div.id = 'wv' + s + "_" + Math.floor(Math.random() * 65535) + '_' + Math.floor(Math.random() * 255);
				pdiv.appendChild(div);

				div.style.border = '2px solid blue';
			}

			var wavesurfer = WaveSurfer.create({
				container: '#' + div.id,
				progressColor: '#0080FF',
				waveColor: '#aaa'
			});

			ws_rtp_playback_control_create(div, wavesurfer);

			var label = null;
			if (node['ws_title'])
				label = dom_create_label("Stream: " + node['ws_title']);
			else
				label = dom_create_label("URL: " + url);

			div.insertBefore(label, div.firstChild);

			if (node['ws_rtp'])
			{
				wavesurfer.on("audioprocess", function () {
					var ts = wavesurfer.getCurrentTime();

					player_sync_view(node['ws_rtp'], ts);
				});

				wavesurfer.on("seek", function () {
					var ts = wavesurfer.getCurrentTime();

					player_sync_view(node['ws_rtp'], ts);
				});

				_webshark_rtps_players_name[node['ws_rtp']] = wavesurfer;
			}

			wavesurfer.on('ready', function () {
				wavesurfer.play();
			});

			wavesurfer.load(url);

			_webshark_rtps_players[url] = wavesurfer;
		}

		ev.preventDefault();
	}
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

function ch_escape(ch)
{
	switch (ch)
	{
		case '&': return '&amp;';
		case '<': return '&lt;';
		case '>': return '&gt;';
	}

	return ch;
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

function webshark_get_base_url()
{
	var base_url = window.location.href.split("?")[0];

	return base_url;
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
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/eye.svg */
		'analyse': "M1664 960q-152-236-381-353 61 104 61 225 0 185-131.5 316.5t-316.5 131.5-316.5-131.5-131.5-316.5q0-121 61-225-229 117-381 353 133 205 333.5 326.5t434.5 121.5 434.5-121.5 333.5-326.5zm-720-384q0-20-14-34t-34-14q-125 0-214.5 89.5t-89.5 214.5q0 20 14 34t34 14 34-14 14-34q0-86 61-147t147-61q20 0 34-14t14-34zm848 384q0 34-20 69-140 230-376.5 368.5t-499.5 138.5-499.5-139-376.5-368q-20-35-20-69t20-69q140-229 376.5-368t499.5-139 499.5 139 376.5 368q20 35 20 69z",
		/* https://raw.githubusercontent.com/encharm/Font-Awesome-SVG-PNG/master/black/svg/comment-o.svg */
		'comment': 'M896 384q-204 0-381.5 69.5t-282 187.5-104.5 255q0 112 71.5 213.5t201.5 175.5l87 50-27 96q-24 91-70 172 152-63 275-171l43-38 57 6q69 8 130 8 204 0 381.5-69.5t282-187.5 104.5-255-104.5-255-282-187.5-381.5-69.5zm896 512q0 174-120 321.5t-326 233-450 85.5q-70 0-145-8-198 175-460 242-49 14-114 22h-5q-15 0-27-10.5t-16-27.5v-1q-3-4-.5-12t2-10 4.5-9.5l6-9 7-8.5 8-9q7-8 31-34.5t34.5-38 31-39.5 32.5-51 27-59 26-76q-157-89-247.5-220t-90.5-281q0-174 120-321.5t326-233 450-85.5 450 85.5 326 233 120 321.5z',
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

function webshark_d3_sequence_diagram(svg, nodes, flows)
{
	svg.append("marker")
         .attr("id", "arr")
         .attr("markerWidth", "10")
         .attr("markerHeight", "10")
         .attr("refX", "6")
         .attr("refY", "3")
         .attr("orient", "auto")
         .attr("markerUnits", "strokeWidth")
         .append("path")
           .attr("d", "M0,0 L0,6 L9,3 z");

	var g = svg.append("g")
         .attr("transform", "translate(10, 10)");

	var color = null;
	if (nodes.length < 10)
		color = d3.schemeCategory10;
	else if (nodes.length < 20)
		color = d3.schemeCategory20;

	for (var i = 0; i < flows.length; i++)
	{
		var posY = 30 + i * 50;

		var nn = flows[i]['n'];

		/* timestamp */
		g.append("text")
		  .attr("class", "seq_ts")
		  .attr("x", 5)
		  .attr("y", posY + 43)
		  .text(flows[i]['t']);

		/* text */
		g.append("text")
		  .attr("class", "seq_label")
		  .attr("x", 500)
		  .attr("y", posY + 43)
		  .text(flows[i]['c']);

		/* line */
		g.append("line")
		  .attr("class", "seq_line")
		  .attr("x1", 100 + nn[0] * 300)
		  .attr("y1", posY + 50)
		  .attr("x2", 100 + nn[1] * 300)
		  .attr("y2", posY + 50)
		  .attr("marker-end", 'url(#arr)')
		  .attr("stroke", (color != null) ? color[nn[0]] : 'black');
	}

	for (var i = 0; i < nodes.length; i++)
	{
		var posX = 100 + 300 * i;
		var endY = 30 + flows.length * 50;

		/* host */
		g.append("text")
		  .attr("class", "seq_host")
		  .attr("x", posX)
		  .attr("y", 10)
		  .text(nodes[i]);

		/* vertical lines */
		g.append("line")
		  .attr("class", "seq_node_line")
		  .attr("x1", posX)
		  .attr("y1", 20)
		  .attr("x2", posX)
		  .attr("y2", endY)
		  .attr("stroke", '#ccc');
	}

	svg.attr("width", Math.max(1000, 120 + (nodes.length) * 300))
		.attr("height", 50 + (flows.length) * 50);

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
		webshark_load_frame(frame_node.data_ws_frame, false);
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
	p.appendChild(document.createTextNode('File: ' + file['_path']));
	div.appendChild(p);

	if (file['size'])
	{
		p = document.createElement('p');
		p.appendChild(document.createTextNode('Size: ' + file['size']));
		div.appendChild(p);
	}

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

		file['url'] = webshark_get_base_url() + '?file=' + file['_path'];

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

var _prev_tap_selected_on_click = null;

function webshark_tap_row_on_click(ev)
{
	var node;
	var action = null;

	node = dom_find_node_attr(ev.target, 'data_wlan_details');
	if (node != null)
		action = 'data_wlan_details';

	if (action == null)
	{
		node = dom_find_node_attr(ev.target, 'data_ws_analyse');
		if (node != null)
			action = 'data_ws_analyse';
	}

	if (action == null)
	{
		node = dom_find_node_attr(ev.target, 'data_ws_filter');
		if (node != null)
			action = 'data_ws_filter';
	}

	if (action == null)
	{
		var node_rtp = dom_find_node_attr(ev.target, 'data_ws_rtp_name');
		node = dom_find_node_attr(ev.target, 'data_ws_rtp_pos');

		if (node && node_rtp)
		{
			var rtp_str = node_rtp['data_ws_rtp_name'];

			var wave = _webshark_rtps_players_name[rtp_str];
			if (wave)
			{
				var pos = node['data_ws_rtp_pos'] / wave.getDuration();
				wave.seekAndCenter(pos);
			}

			/* wavesurfer seek callback will take care about highlighting */
			return;
		}
	}

	if (node != null)
	{
		if (_prev_tap_selected_on_click)
			dom_remove_class(_prev_tap_selected_on_click, "selected");

		dom_add_class(node, "selected");
		_prev_tap_selected_on_click = node;

		if (action == 'data_wlan_details')
		{
			var details = node['data_wlan_details'][0];
			var item    = node['data_wlan_details'][1];

			var tap_table = document.getElementById('ws_tap_table');
			var tap_extra = document.getElementById('ws_tap_details');

			tap_extra.style.display = 'block';
			tap_extra.innerHTML = "";

			/* XXX< hacky, add parameters to webshark_render_tap() */
			tap_table.id = '';
			tap_extra.id = 'ws_tap_table';

			data =
				{
					type: 'fake-wlan-details',
					items: details,
					orig_item: item
				};
			webshark_render_tap(data);

			tap_table.id = 'ws_tap_table';
			tap_extra.id = 'ws_tap_details';
		}

		if (action == 'data_ws_analyse')
		{
			var anal = node['data_ws_analyse'];

			var tap_req =
				{
					req: 'tap',
					capture: _webshark_file,
					tap0: anal
				};

			webshark_json_get(tap_req,
				function(data)
				{
					var tap_table = document.getElementById('ws_tap_table');
					var tap_extra = document.getElementById('ws_tap_details');

					tap_extra.style.display = 'block';
					tap_extra.innerHTML = "";

					/* XXX< hacky, add parameters to webshark_render_tap() */
					tap_table.id = '';
					tap_extra.id = 'ws_tap_table';

					for (var i = 0; i < data['taps'].length - 1; i++)
						webshark_render_tap(data['taps'][i]);

					tap_table.id = 'ws_tap_table';
					tap_extra.id = 'ws_tap_details';
				});
		}

		if (action == 'data_ws_filter')
		{
			var filter = node['data_ws_filter'];
			document.getElementById('ws_packet_list_view').style.display = 'block';

			_webshark.setFilter(filter);
		}
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

function webshark_frame_comment_on_over(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (node != null)
	{
		var framenum = node.data_ws_frame;

		_webshark.getComment(framenum,
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

function webshark_frame_comment_on_click(ev)
{
	var node;

	node = dom_find_node_attr(ev.target, 'data_ws_frame');
	if (node != null)
	{
		var framenum = node.data_ws_frame;

		_webshark.getComment(framenum,
			function(data)
			{
				var prev_comment = data['comment'];

				var comment = window.prompt("Please enter new comment for frame #" + framenum, prev_comment);
				if (comment != null)
					_webshark.setComment(framenum, comment);
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

function ws_rtp_playback_control_play_pause(wave, x)
{
	for (var w in _webshark_rtps_players)
	{
		var wv = _webshark_rtps_players[w];

		if (!wave || wave == wv)
		{
			if (x == 'toggle') wv.playPause();
			if (x == 'start') wv.play(0);
		}
	}

}

function ws_rtp_playback_control_skip(wave, x)
{
	for (var w in _webshark_rtps_players)
	{
		var wv = _webshark_rtps_players[w];

		if (!wave || wave == wv)
			wv.skip(x);
	}
}

function ws_rtp_playback_control_speed(wave, x)
{
	for (var w in _webshark_rtps_players)
	{
		var wv = _webshark_rtps_players[w];

		if (!wave || wave == wv)
			wv.setPlaybackRate(x);
	}
}

function ws_rtp_playback_control_create(pdiv, wave)
{
	var control_div = document.createElement('div');
	var btn;

	if (wave == null)
		control_div.appendChild(dom_create_label("All loaded streams"));

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "Play from start";
	control_div.appendChild(btn);
	btn.onclick = function() { ws_rtp_playback_control_play_pause(wave, 'start'); }

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "Backward 10s";
	btn.onclick = function() { ws_rtp_playback_control_skip(wave, -10); }
	control_div.appendChild(btn);

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "Backward 5s";
	btn.onclick = function() { ws_rtp_playback_control_skip(wave, -5); }
	control_div.appendChild(btn);

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "Play/Pause";
	control_div.appendChild(btn);
	btn.onclick = function() { ws_rtp_playback_control_play_pause(wave, 'toggle'); }

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "Forward 5s";
	btn.onclick = function() { ws_rtp_playback_control_skip(wave, 5); }
	control_div.appendChild(btn);

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "Forward 10s";
	btn.onclick = function() { ws_rtp_playback_control_skip(wave, 10); }
	control_div.appendChild(btn);

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "0.5x";
	control_div.appendChild(btn);
	btn.onclick = function() { ws_rtp_playback_control_speed(wave, 0.5); }

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "1.0x";
	control_div.appendChild(btn);
	btn.onclick = function() { ws_rtp_playback_control_speed(wave, 1); }

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "1.5x";
	control_div.appendChild(btn);
	btn.onclick = function() { ws_rtp_playback_control_speed(wave, 1.5); }

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "2.0x";
	control_div.appendChild(btn);
	btn.onclick = function() { ws_rtp_playback_control_speed(wave, 2); }

	btn = document.createElement("button");
	btn.className = "btn btn-primary";
	btn.innerHTML = "4.0x";
	control_div.appendChild(btn);
	btn.onclick = function() { ws_rtp_playback_control_speed(wave, 4); }

/*
	if (wave != null)
	{
		var span = document.createElement("span");
		span.innerHTML = " Loading";
		control_div.appendChild(span);
	}
 */

/*
    <button class="btn btn-primary" onclick="wavesurfer.toggleMute()">
      <i class="fa fa-volume-off"></i>
      Toggle Mute
    </button>
*/

	control_div.setAttribute('align', 'center');

	pdiv.insertBefore(control_div, pdiv.firstChild);
}

function webshark_dir_on_click(ev)
{
	var node = dom_find_node_attr(ev.target, 'data_ws_dir');
	if (node != null)
	{
		var dir = node['data_ws_dir'];
		webshark_load_files(dir);
		ev.preventDefault();
	}
}

function webshark_create_file_row_html(file, row_no)
{
	var tr = document.createElement("tr");

	var si_format = d3.format('.2s');

	var stat = file['status'];

	var data = [
		file['name'],
		file['dir'] ? "[DIR]" : (si_format(file['size']) + "B"),
		file['desc'] ? file['desc'] : "",
	];

	var a_href = document.createElement("a");
	if (file['dir'])
	{
		data[0] = file['_path'];

		a_href.setAttribute("href", webshark_get_base_url() + "?dir=" + file['_path']);
		a_href['data_ws_dir'] = file['_path'];
		a_href.addEventListener("click", webshark_dir_on_click);
	}
	else
	{
		a_href.setAttribute("href", webshark_get_base_url() + "?file=" + file['_path']);
	}
	a_href.appendChild(document.createTextNode(data[0]));

	for (var j = 0; j < data.length; j++)
	{
		var td = document.createElement("td");

		if (j == 0) /* before filename */
		{
			var glyph = null;

			if (file['pdir'])
			{
				glyph = webshark_glyph_img('pfolder', 16);
				glyph.setAttribute('alt', 'Open Directory');
				glyph.setAttribute('title', 'Open Directory');
			}
			else if (file['dir'])
			{
				glyph = webshark_glyph_img('folder', 16);
				glyph.setAttribute('alt', 'Directory');
				glyph.setAttribute('title', 'Directory');
			}
			else if (stat && stat['online'])
			{
				glyph = webshark_glyph_img('play', 16);
				glyph.setAttribute('alt', 'Running');
				glyph.setAttribute('title', 'Running ...');
			}
			else
			{
				glyph = webshark_glyph_img('stop', 16);
				glyph.setAttribute('alt', 'Stopped');
				glyph.setAttribute('title', 'Stopped');
			}
			if (glyph)
				td.appendChild(glyph);
			td.appendChild(document.createTextNode(' '));
		}

		if (j == 0)
			td.appendChild(a_href);
		else
			td.appendChild(document.createTextNode(data[j]));
		tr.appendChild(td);
	}

	if (file['cdir'] == true)
	{
		tr.style['background-color'] = '#ffffb0';
	}
	else if (stat && stat['online'] == true)
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

				var comment_glyph = webshark_glyph_img('comment', 16);
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

	if (fnum == _webshark_current_frame)
		dom_add_class(tr, 'selected');

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

		if (_webshark.checkFieldFilter(finfo) == false)
			continue;

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

		if (finfo['f'])
		{
			var filter_a = document.createElement('a');

			filter_a.setAttribute("target", "_blank");
			filter_a.setAttribute("style", "float: right;");
			filter_a.setAttribute("href", webshark_get_url()+ "&filter=" + encodeURIComponent(finfo['f']));
			filter_a.addEventListener("click", popup_on_click_a);
			/*
			filter_a.data_ws_filter = finfo['f'];
			filter_a.addEventListener("click", webshark_tap_row_on_click);
			*/

			var glyph = webshark_glyph_img('filter', 12);
			glyph.setAttribute('alt', 'Filter: ' + finfo['f']);
			glyph.setAttribute('title', 'Filter: ' + finfo['f']);

			filter_a.appendChild(glyph);

			li.appendChild(filter_a);
		}

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
			if (_webshark.field_filter)
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

var webshark_rtp_analyse_fields =
{
	'_frame_time': 'Packet (Time)',
	'sn': 'Sequence',
	'd': 'Delta (ms)',
	'j': 'Filtered jitter (ms)',
	'sk': 'Skew (ms)',
	'bw': 'IP BW (kbps)',
	'_marker_str': 'Marker',
	'_status': 'Status'
};

var webshark_rtd_fields =
{
	'type':    'Type',
	'num':     'Messages',
	'_min':    'Min SRT [ms]',
	'_max':    'Max SRT [ms]',
	'_avg':    'AVG SRT [ms]',
	'min_frame': 'Min in Frame',
	'max_frame': 'Max in Frame',

/* optional */
	'open_req': 'Open Requests',
	'disc_rsp': 'Discarded Responses',
	'req_dup':  'Duplicated Requests',
	'rsp_dup':  'Duplicated Responses'
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

var webshark_wlan_fields =
{
	'_bssid': "BSSID",
	'chan':  "Ch.",
	'ssid':  "SSID",
	'_perc':  "% Packets",
	't_beacon': "Beacons",
	't_data':    "Data Packets",
	't_probe_req': "Probe Req",
	't_probe_resp': "Probe Resp",
	't_auth': "Auth",
	't_deauth': "Deauth",
	't_other': "Other",
	'protection': "Protection"
};

var webshark_wlan_details_fields =
{
	'araw': 'Address',
	'_perc': '% Packets',
	't_data_sent': 'Data Sent',
	't_data_recv': 'Data Received',
	't_probe_req': 'Probe Req',
	't_probe_rsp': 'Probe Resp',
	't_auth': 'Auth',
	't_deauth': 'Deauth',
	't_other': 'Other',
	'_comment': 'Comment'
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

		if (val['_wlan_extra_data'] != undefined)
		{
			tr.data_wlan_details = val['_wlan_extra_data'];
			tr.addEventListener("click", webshark_tap_row_on_click);
		}
		else if (val['_rtp_goto'] != undefined)
		{
			tr.data_ws_rtp_pos = val['_rtp_goto'];
			tr.addEventListener("click", webshark_tap_row_on_click);
		}
		else if (val['_analyse'])
		{
			tr.data_ws_analyse = val['_analyse'];
			tr.addEventListener("click", webshark_tap_row_on_click);
		}
		else if (val['_filter'])
		{
			tr.data_ws_filter = val['_filter'];
			tr.addEventListener("click", webshark_tap_row_on_click);
		}

		table.appendChild(tr);
	}
}

function webshark_create_tap_action_common(data)
{
	var td = document.createElement('td');

	if (data['_analyse'])
	{
		var anal_a = document.createElement('a');

		anal_a.setAttribute("target", "_blank");
		anal_a.setAttribute("href", webshark_get_url()+ "&tap=" + encodeURIComponent(data['_analyse']));
		anal_a.addEventListener("click", popup_on_click_a);

		var glyph = webshark_glyph_img('analyse', 16);
		glyph.setAttribute('alt', 'Details: ' + data['_analyse']);
		glyph.setAttribute('title', 'Details: ' + data['_analyse']);

		anal_a.appendChild(glyph);
		td.appendChild(anal_a);
	}

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

	if (data['_goto_frame'])
	{
		var show_a = document.createElement('a');

		show_a.setAttribute("target", "_blank");
		show_a.setAttribute("href", webshark_get_url()+ "&frame=" + data['_goto_frame']);
		show_a.addEventListener("click", popup_on_click_a);

		var glyph = webshark_glyph_img('analyse', 16);
		glyph.setAttribute('alt', 'Load frame: ' + data['_filter']);
		glyph.setAttribute('title', 'Load frame: ' + data['_filter']);

		show_a.appendChild(glyph);
		td.appendChild(show_a);
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

	if (data['_play'])
	{
		var down_a = document.createElement('a');

		var descr = data['_play_descr'];
		if (!descr)
			descr = data['_play'];

		down_a.setAttribute("target", "_blank");
		down_a["ws_title"] = descr;
		down_a["ws_rtp"] = data['_play'];
		down_a.setAttribute("href", _webshark_url + 'req=download&capture=' + _webshark_file  + "&token=" + encodeURIComponent(data['_play']));
		down_a.addEventListener("click", play_on_click_a);

		var glyph = webshark_glyph_img('play', 16);
		glyph.setAttribute('alt', 'Load and play RTP: ' + descr);
		glyph.setAttribute('title', 'Load and play RTP: ' + descr);

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
			mwidth: 500, iwidth: 220, height: 400,

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
			mwidth: 500, iwidth: 220, height: 400,

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
			mwidth: 400, iwidth: 110, height: 400,

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
			mwidth: 400, iwidth: 110, height: 400,

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
	else if (tap['type'] == 'flow')
	{
		var nodes = tap['nodes'];
		var flows = tap['flows'];

		var svg = d3.select("body").append("svg").remove()
				.attr("style", 'border: 1px solid black;');

		webshark_d3_sequence_diagram(svg, nodes, flows);

		document.getElementById('ws_tap_graph').appendChild(svg.node());
	}
	else if (tap['type'] == 'nstat')
	{
		var nstat_fields = tap['fields'];
		var nstat_tables = tap['tables'];

		var fields = { };

		for (var i = 0; i < nstat_fields.length; i++)
		{
			fields['' + i] = nstat_fields[i]['c'];
		}

		for (var i = 0; i < nstat_tables.length; i++)
		{
			var nstat_table = tap['tables'][i];

			var table = webshark_create_tap_table_common(fields);

			webshark_create_tap_table_data_common(fields, table, nstat_table['i']);

			document.getElementById('ws_tap_table').appendChild(dom_create_label('Statistics (' + nstat_table['t'] + ') '));

			document.getElementById('ws_tap_table').appendChild(table);
		}

	}
	else if (tap['type'] == 'rtd')
	{
		var table = webshark_create_tap_table_common(webshark_rtd_fields);

		var rtd_stats = tap['stats'];

		for (var i = 0; i < rtd_stats.length; i++)
		{
			var row = rtd_stats[i];

			row['_min'] = prec_trunc(100, row['min'] * 1000.0);
			row['_max'] = prec_trunc(100, row['max'] * 1000.0);
			row['_avg'] = prec_trunc(100, (row['tot'] / row['num']) * 1000.0);

			/* TODO: calculate % if row['open_req'] */
		}

		webshark_create_tap_table_data_common(webshark_rtd_fields, table, rtd_stats);

		document.getElementById('ws_tap_table').appendChild(dom_create_label('Response Time Delay (' + tap['tap'] + ') '));

		if (tap['open_req'] != undefined)
		{
			var rdiv = document.createElement('div');
			rdiv.appendChild(dom_create_label_span("Open Requests: " + tap['open_req']));
			rdiv.appendChild(dom_create_label_span(", Discarded Responses: " + tap['disc_rsp']));
			rdiv.appendChild(dom_create_label_span(", Duplicated Requests: " + tap['req_dup']));
			rdiv.appendChild(dom_create_label_span(", Duplicated Responses: " + tap['rsp_dup']));

			document.getElementById('ws_tap_table').appendChild(rdiv);
		}

		document.getElementById('ws_tap_table').appendChild(table);

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

			item['_goto_frame'] = item['f'];
		}

		webshark_create_tap_table_data_common(webshark_expert_fields, table, details);

		document.getElementById('ws_tap_table').appendChild(dom_create_label("Expert information (" + details.length + ')'));
		document.getElementById('ws_tap_table').appendChild(table);
	}
	else if (tap['type'] == 'wlan')
	{
		var table = webshark_create_tap_table_common(webshark_wlan_fields);
		var list = tap['list'];

		list.sort(function(a, b)
		{
			var pkta = a['packets'], pktb = b['packets'];

			return pkta < pktb ? 1 : -1;
		});

		for (var i = 0; i < list.length; i++)
		{
			var item = list[i];

			item['_bssid']  = (item['bname'] ? item['bname'] : item['braw']);
			item['_filter'] = "wlan.bssid == " + item['braw'];
			item['_perc']  = prec_trunc(100, 100 * (item['packets'] / tap['packets'])) + '%';

			item['_wlan_extra_data'] = [ item['details'], item ];
		}

		webshark_create_tap_table_data_common(webshark_wlan_fields, table, list);

		document.getElementById('ws_tap_table').appendChild(dom_create_label("WLAN Traffic Statistics"));
		document.getElementById('ws_tap_table').appendChild(table);
	}
	else if (tap['type'] == 'fake-wlan-details')
	{
		var list = tap['items'];
		var orig_item = tap['orig_item'];

		var orig_item_packet_total = orig_item['packets'] - orig_item['t_beacon'];

		list.sort(function(a, b)
		{
			var pkta = a['packets'], pktb = b['packets'];

			return pkta < pktb ? 1 : -1;
		});

		for (var i = 0; i < list.length; i++)
		{
			var item = list[i];

			if (orig_item_packet_total)
				item['_perc']  = prec_trunc(100, 100 * (item['packets'] / orig_item_packet_total)) + '%';
			else
				item['_perc'] = prec_trunc(100, 0) + '%';

			if (item['araw'] == 'ff:ff:ff:ff:ff:ff')
				item['_comment'] = 'Broadcast';
			else if (orig_item['braw'] == item['araw'])
				item['_comment'] = 'Base station';
			else
				item['_comment'] = '';
		}

		var table = webshark_create_tap_table_common(webshark_wlan_details_fields);

		webshark_create_tap_table_data_common(webshark_wlan_details_fields, table, list);

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

			var rtp_str = stream['saddr'] + '_' + stream['sport'] + '_' + stream['daddr'] + '_' + stream['dport'] + '_' + xtoa(stream['ssrc'], 0);

			stream['_analyse'] = 'rtp-analyse:' + rtp_str;
			stream['_download'] = 'rtp:' + rtp_str;
			stream['_play'] = stream['_download'];
			stream['_play_descr'] = '[' + stream['saddr'] + ']:' + stream['sport'] + ' -> [' + stream['daddr'] + ']:' + stream['dport'] + " SSRC: " + stream['_ssrc'] + ' ' + stream['payload'];

			stream['_filter'] = "(" + ipstr + ".src == " + stream['saddr'] + " && udp.srcport == " + stream['sport'] + " && " +
			                          ipstr + ".dst == " + stream['daddr'] + " && udp.dstport == " + stream['dport'] + " && " +
			                          "rtp.ssrc == " + stream['_ssrc'] +
			                    ")";
		}

		var wave_div = document.createElement('div');
		wave_div.id = 'ws_rtp_playback';
		ws_rtp_playback_control_create(wave_div, null);

		webshark_create_tap_table_data_common(webshark_rtp_streams_fields, table, streams);

		document.getElementById('ws_tap_table').appendChild(dom_create_label("RTP streams (" + streams.length + ')'));
		document.getElementById('ws_tap_table').appendChild(table);
		document.getElementById('ws_tap_table').appendChild(wave_div);
	}
	else if (tap['type'] == 'rtp-analyse')
	{
		var table = webshark_create_tap_table_common(webshark_rtp_analyse_fields);
		var items = tap['items'];

		var rtp_str = "rtp:" + tap['tap'].slice(12);

		for (var i = 0; i < items.length; i++)
		{
			var item = items[i];

			item['_frame_time'] = item['f'] + ' (' + item['o'] + ')';
			item['_marker_str'] = (item['mark'] == 1) ? "Set" : "";

			if (item['s'])
				item['_status'] = item['s'];
			else
				item['_status'] = '[ OK ]';

			item['_rtp_goto'] = item['o'];
			item['_goto_frame'] = item['f'];
		}

		table['data_ws_rtp_name'] = rtp_str;

		_webshark_rtps_table[rtp_str] = [ items, table, null ];
		webshark_create_tap_table_data_common(webshark_rtp_analyse_fields, table, items);

		document.getElementById('ws_tap_table').appendChild(dom_create_label("RTP analysis"));
		{
			var rdiv = document.createElement('div');

			rdiv.appendChild(dom_create_label_span("SSRC: 0x" + xtoa(tap['ssrc'], 0)));

			rdiv.appendChild(dom_create_label_span(", Max Delta: " + tap['max_delta'] + ' ms @ ' + tap['max_delta_nr']));
			rdiv.appendChild(dom_create_label_span(", Max Jitter: " + tap['max_jitter'] + " ms"));
			rdiv.appendChild(dom_create_label_span(", Mean Jitter: " + tap['mean_jitter'] + " ms"));
			rdiv.appendChild(dom_create_label_span(", Max Skew: " + tap['max_skew'] + " ms"));
			rdiv.appendChild(dom_create_label_span(", RTP Packets: " + tap['total_nr']));
			rdiv.appendChild(dom_create_label_span(", Seq Errs: " + tap['seq_err']));
			rdiv.appendChild(dom_create_label_span(", Duration: " + prec_trunc(1000, tap['duration'] / 1000) + " s"));
			document.getElementById('ws_tap_table').appendChild(rdiv);
		}
		document.getElementById('ws_tap_table').appendChild(table);
	}
}

var _webshark_interval = null;
var _webshark_interval_scale = null;
var _webshark_interval_filter = null;
var _webshark_interval_mode = "";

function webshark_render_interval()
{
	var intervals_data   = _webshark_interval ? _webshark_interval['intervals'] : null;
	var intervals_filter = _webshark_interval_filter ? _webshark_interval_filter['intervals'] : null;
	var intervals_full = [ ];

	var last_one  = _webshark_interval ? _webshark_interval['last'] : _webshark_interval_filter['last'];
	var color_arr = [ 'steelblue' ];

	var count_idx =
		(_webshark_interval_mode == "bps") ? 2 :
		(_webshark_interval_mode == "fps") ? 1 :
		-1;

	if (count_idx == -1)
		return;

	for (var i = 0; i <= last_one; i++)
		intervals_full[i] = [ (i * _webshark_interval_scale), 0, 0 ];

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

		xrange: [ 0, (last_one * _webshark_interval_scale) ],

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

function webshark_load_files(dir)
{
	var files_req =
		{
			req: 'files'
		};

	if (dir)
		files_req['dir'] = dir;

	webshark_json_get(files_req,
		function(data)
		{
			var pwd = data['pwd'];
			var fullpwd;
			var files = data['files'];

			if (pwd == '.' || pwd == '/')
			{
				pwd = '/';
				fullpwd = '/';
			}
			else
			{
				pwd = '/' + pwd;
				fullpwd = pwd + '/';
			}

			for (var i = 0; i < files.length; i++)
			{
				var item = files[i];

				item['_path'] = fullpwd + item['name'];
			}

			files.sort(function(a, b)
			{
				var sta = a['status'], stb = b['status'];
				var ona, onb;

				/* first directory */
				ona = (a['dir'] == true) ? 1 : 0;
				onb = (b['dir'] == true) ? 1 : 0;
				if (ona != onb)
					return ona < onb ? 1 : -1;

				/* than online */
				ona = (sta && sta['online'] == true) ? 1 : 0;
				onb = (stb && stb['online'] == true) ? 1 : 0;
				if (ona != onb)
					return ona < onb ? 1 : -1;

				/* and than by filename */
				return a['name'] > b['name'] ? 1 : -1;
			});

			/* some extra directories always on top */
			files.unshift({ cdir: true, pdir: true, name: fullpwd, _path: fullpwd, 'dir': true, 'desc': '' });

			while (pwd != '/' && pwd != '')
			{
				var parentdir = pwd.substring(0, pwd.lastIndexOf('/'));

				if (parentdir.length != 0)
					files.unshift({ pdir: true, name: parentdir, _path: parentdir, 'dir': true, 'desc': '' });

				pwd = parentdir;
			}

			if (fullpwd != '/')
				files.unshift({ pdir: true, name: '/', _path: '/', 'dir': true, 'desc': '' });

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
var _webshark_current_frame_tree = null;

function webshark_load_frame(framenum, scroll_to, cols)
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

	webshark_json_get(
		{
			req: 'frame',
			bytes: 'yes',
			proto: 'yes',
			capture: _webshark_file,
			frame: framenum
		},
		function(data)
		{
			var bytes_data = [ ];

			_webshark_current_frame_tree = data['tree'];
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

			if (_webshark_on_frame_change != null)
			{
				_webshark_on_frame_change(framenum, data);
			}

			_webshark_current_frame = framenum;

			/* select new */
			var obj = document.getElementById('packet-list-frame-' + framenum);
			if (obj)
			{
				dom_add_class(obj, 'selected');
				if (scroll_to)
					obj.scrollIntoView(false);
			}

		});
}

function webshark_load_tap(taps)
{
	var tap_req =
		{
			req: 'tap',
			capture: _webshark_file
		};

	for (var i = 0; i < taps.length; i++)
		tap_req["tap" + i] = taps[i];

	webshark_json_get(tap_req,
		function(data)
		{
			for (var i = 0; i < data['taps'].length - 1; i++)
				webshark_render_tap(data['taps'][i]);
		});
}

function webshark_load_follow(follow, filter)
{
	webshark_json_get(
		{
			req: 'follow',
			capture: _webshark_file,
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
			_webshark.setFilter(filter);

		});
}
