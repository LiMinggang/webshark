#!/bin/sh

set -x

# Update wireshark sources
git pull
git reset --hard b2d3680558d19998c55b48e9807a26e145756eba   ## tested with this hash

# Integrate sharkd
patch -p1 < ../sharkd/sharkd.patch
patch -p1 < ../sharkd/sharkd_opt_memory.patch ## optional
cp ../sharkd/*.[ch] ./

# Compile sharkd static, and without optional libraries
./autogen.sh
export CFLAGS="-O3 -pipe"
./configure \
	--disable-shared --enable-static --disable-plugins --disable-warnings-as-errors \
	--disable-wireshark --disable-tshark --disable-sharkd --disable-dumpcap --disable-capinfos \
	--disable-captype --disable-randpkt --disable-dftest --disable-editcap --disable-mergecap \
	--disable-reordercap --disable-text2pcap --disable-fuzzshark \
	--without-extcap --without-pcap --without-gnutls --without-geoip

make -j8
make sharkd

# Generate tarball in /out directory
strip sharkd
mkdir -p ./usr/local/bin/ ./usr/local/share/wireshark/
cp sharkd ./usr/local/bin/
cp colorfilters ./usr/local/share/wireshark/
tar -vczf /out/sharkd.tar.gz ./usr
