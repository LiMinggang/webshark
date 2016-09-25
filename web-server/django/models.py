from django.db import models

class Capture(models.Model):
    filename = models.CharField(max_length=256, unique=True)
    description = models.CharField(max_length=512)
    analysis = models.TextField()

    def __str__(self):
        return self.filename

class CaptureSettings(models.Model):
    capture = models.ForeignKey(Capture, on_delete=models.CASCADE)
    var     = models.CharField(max_length=128)
    value   = models.CharField(max_length=1024)

    def __str__(self):
        return self.var + " for " + str(self.capture)
