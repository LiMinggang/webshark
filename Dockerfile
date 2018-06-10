## example: docker run -v ~/pcaps:/caps -p 8000:80 -it webshark/webshark:devel
FROM ubuntu:18.04
MAINTAINER Jakub Zawadzki <darkjames-ws@darkjames.pl>
RUN apt-get update && apt-get install -y \
	python3-django libglib2.0-0 \
	&& rm -rf /var/lib/apt/lists/*

## GeoIP in /var/lib/GeoIP/GeoLite2-City.mmdb
# RUN apt-get update && apt-get install -y libmaxminddb0 geoipupdate && geoipupdate -v

RUN mkdir -p /caps
VOLUME /caps

RUN django-admin startproject web && \
    chmod +x web/manage.py
WORKDIR ./web

RUN ./manage.py startapp webshark

RUN mkdir -p ./webshark/static/webshark/
COPY web/ ./webshark/static/webshark/

RUN echo "INSTALLED_APPS += ('webshark',)" >> web/settings.py && \
    echo "SHARKD_CAP_DIR = '/caps/'" >> web/settings.py && \
    echo "ALLOWED_HOSTS = ['*']" >> web/settings.py && \
    echo "from django.conf.urls import include" >> web/urls.py && \
    echo "urlpatterns += [ url(r'^webshark/', include('webshark.urls')), ]" >> web/urls.py

COPY sharkd_cli.py web-server/django/urls.py web-server/django/views.py web-server/django/models.py web-server/django/forms.py webshark/

RUN ./manage.py makemigrations
RUN ./manage.py migrate

## See README.md for sharkd.tar.gz build instructions.
ADD sharkd.tar.gz /

EXPOSE 80
CMD ["./manage.py", "runserver", "0.0.0.0:80"]
