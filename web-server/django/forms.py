from django import forms

class UploadFileForm(forms.Form):
    f = forms.FileField()
