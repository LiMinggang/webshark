Webshark
==============================

Wireshark interface for web.

You can try it on openshift (http://webshark-darkjames.rhcloud.com/static/webshark/).

Building webshark docker image
-------------

Get wireshark sources:
	$ git clone https://code.wireshark.org/review/wireshark
	$ cd wireshark
	$ git reset --hard ede140a46a2af7febaaade67453c4c8f1d6c946d   ## tested with this hash

Apply sharkd:
	$ patch -p1 < ../sharkd/sharkd.patch
	$ patch -p1 < ../sharkd/sharkd_opt_memory.patch ## optional
	$ cp ../sharkd/*.c ./

Compile sharkd static, and without optional libraries:
	$ ./autogen.sh
	$ export CFLAGS="-O3 -pipe -w"
	$ ./configure \
		--disable-wireshark --without-extcap --without-pcap --disable-dumpcap --without-plugins \
		--disable-shared --enable-static \
		--without-ssl --without-gcrypt --without-gnutls
	$ make -j8
	$ make sharkd

Generate binary tarball:
	$ strip sharkd
	$ mkdir -p ./usr/local/bin/ ./usr/local/share/wireshark/
	$ cp sharkd ./usr/local/bin/
	$ cp colorfilters ./usr/local/share/wireshark/
	$ tar -vczf ../sharkd.tar.gz ./usr
	$ cd ..                ## back into webshark directory
	$ rm -rf wireshark/    ## wireshark sources no longer needed

Build and run docker image:
	$ docker build .
	$ docker run -v ~/pcaps:/caps -p 8000:80 -it <build image>

Check if webshark is working, and analyse pcap files (you can monitor console with webshark run for status):
	$ http://localhost:8000/static/webshark/index.html
	$ http://localhost:8000/webshark/json?req=refreshdb
