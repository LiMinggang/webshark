## example: docker run -v ~/pcaps:/caps -p 8000:80 -it webshark/webshark:devel
FROM ubuntu:16.10
MAINTAINER Jakub Zawadzki <darkjames-ws@darkjames.pl>
RUN apt-get update && apt-get install -y \
	python3-django libglib2.0-0 \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /caps
VOLUME /caps

RUN django-admin startproject web
WORKDIR ./web

RUN ./manage.py startapp webshark

RUN mkdir -p ./webshark/static/webshark/
COPY web/ ./webshark/static/webshark/

RUN echo "INSTALLED_APPS += ('webshark',)" >> web/settings.py && \
    echo "SHARKD_CAP_DIR = '/caps/'" >> web/settings.py
RUN echo "urlpatterns += [ url(r'^webshark/', include('webshark.urls')), ]" >> web/urls.py

COPY web-server/django/urls.py web-server/django/views.py web-server/django/models.py webshark/

COPY sharkd_cli.py webshark/sharkd_cli.py

RUN ./manage.py makemigrations
RUN ./manage.py migrate

## TODO, push to http, with build instructions
ADD sharkd.tar.gz /

EXPOSE 80
CMD ["./manage.py", "runserver", "0.0.0.0:80"]
