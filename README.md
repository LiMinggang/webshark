Webshark
==============================

Web interface for wireshark.

You can try demo on: https://demo.webshark.io/static/webshark/

Or by running docker image with your capture library:
	$ docker run -v ~/yours_capture_directory:/caps -p 8000:80 -it webshark/webshark:devel

Now you have webshark running under: http://localhost:8000/static/webshark/index.html

Rebuilding database
-------------

To make advanced files filtering (duration, frames count) you must rebuild database by entering: http://yoursite/webshark/json?req=refreshdb
You can monitor status by watching console.

Building webshark docker image
-------------

Build sharkd tarball
~~~~
	$ docker build -t sharkd:latest sharkd/
	$ docker run -v `pwd`:/out:/out --rm -it sharkd:latest
~~~~

Build and run docker image:
~~~~
	$ browserify-lite --standalone webshark ./web/js/webshark.js --outfile web/js/webshark-app.js
	$ docker build -t webshark:latest .
	$ docker run -v ~/pcaps:/caps -p 8000:80 -it webshark:latest
~~~~
