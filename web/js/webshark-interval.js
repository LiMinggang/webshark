/* webshark-interval.js
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

function WSInterval(opts)
{
	this.mode = opts['mode'];
	this.interval_count = opts['width'];

	this.elem = document.getElementById(opts['contentId']);

	this.interval = null;
	this.interval_filter = null;
	this.scale = 1;
}

WSInterval.prototype.setDuration = function(duration)
{
	var scale;

	scale = Math.round(duration / this.interval_count);
	if (scale < 1)
		scale = 1;

	this.scale = scale;
};

WSInterval.prototype.setResult = function(filter, data)
{
	if (filter)
	{
		this.interval_filter = data;
	}
	else
	{
		this.interval = data;
		this.interval_filter = null; /* render only main */
	}

	this.render_interval();
};

WSInterval.prototype.getScale = function()
{
	return this.scale;
};

WSInterval.prototype.render_interval = function()
{
	var intervals_data   = this.interval ? this.interval['intervals'] : null;
	var intervals_filter = this.interval_filter ? this.interval_filter['intervals'] : null;
	var intervals_full = [ ];

	var last_one  = this.interval ? this.interval['last'] : this.interval_filter['last'];
	var color_arr = [ 'steelblue' ];

	var count_idx =
		(this.mode == "bps") ? 2 :
		(this.mode == "fps") ? 1 :
		-1;

	if (count_idx == -1)
		return;

	for (var i = 0; i <= last_one; i++)
		intervals_full[i] = [ (i * this.scale), 0, 0 ];

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

	window.webshark.webshark_d3_chart(svg, intervals_full,
	{
		width: 620, height: 100,
		margin: {top: 0, right: 10, bottom: 20, left: 40},

		xrange: [ 0, (last_one * this.scale) ],

		getX: function(d) { return d[0]; },

		unit1: 'k',
		series3:
		[
			function(d) { return d[1]; },
			function(d) { return d[2]; }
		],

		color: color_arr
	});

	window.webshark.dom_set_child(this.elem, svg.node());
};

exports.WSInterval = WSInterval;
