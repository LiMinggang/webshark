/* webshark-chart.js
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

exports.webshark_d3_chart = webshark_d3_chart;
