Webshark
==============================

Web interface for wireshark.

You can try demo on openshift: http://webshark-darkjames.rhcloud.com/static/webshark/

Or by running docker image with your capture library:
	$ docker run -v ~/yours_capture_directory:/caps -p 8000:80 -it webshark/webshark:devel

Now you have webshark running under: http://localhost:8000/static/webshark/index.html

Rebuilding database
-------------

To make advanced files filtering (duration, frames count) you must rebuild database by entering: http://yoursite/webshark/json?req=refreshdb
You can monitor status by watching console.

Building webshark docker image
-------------

Get wireshark sources:
~~~~
	$ git clone https://code.wireshark.org/review/wireshark
	$ cd wireshark
	$ git reset --hard ad2eb833c8f646c7bd8000dec30350f2fe743a33   ## tested with this hash

~~~~

Integrate sharkd:
~~~~
	$ patch -p1 < ../sharkd/sharkd.patch
	$ patch -p1 < ../sharkd/sharkd_opt_memory.patch ## optional
	$ cp ../sharkd/*.[ch] ./
~~~~

Compile sharkd static, and without optional libraries:
~~~~
	$ ./autogen.sh
	$ export CFLAGS="-O3 -pipe -w"
	$ ./configure \
		--disable-wireshark --without-extcap --without-pcap --disable-dumpcap --without-plugins \
		--disable-shared --enable-static \
		--without-ssl --without-gcrypt --without-gnutls
	$ make -j8
	$ make sharkd
~~~~

Generate binary tarball:
~~~~
	$ strip sharkd
	$ mkdir -p ./usr/local/bin/ ./usr/local/share/wireshark/
	$ cp sharkd ./usr/local/bin/
	$ cp colorfilters ./usr/local/share/wireshark/
	$ tar -vczf ../sharkd.tar.gz ./usr
	$ cd ..                ## back into webshark directory
	$ rm -rf wireshark/    ## wireshark sources no longer needed
~~~~

Build and run docker image:
~~~~
	$ docker build .
	$ docker run -v ~/pcaps:/caps -p 8000:80 -it <build image>
~~~~
