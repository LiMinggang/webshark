from django.conf.urls import url

from . import views

urlpatterns = [
    url(r'^upload$', views.upload_file, name='upload_file'),
    url(r'^json$', views.json_req, name='json_req'),
    url(r'^$', views.index, name='index'),
]
