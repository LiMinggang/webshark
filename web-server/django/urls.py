from django.conf.urls import url

from . import views

urlpatterns = [
    url(r'^json$', views.json_req, name='json_req'),
    url(r'^$', views.index, name='index'),
]
