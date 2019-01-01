from django.db import models
from django.conf import settings

class Capture(models.Model):
    filename = models.CharField(max_length=256, unique=True)
    description = models.CharField(max_length=512)
    analysis = models.TextField()

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True)

    def __str__(self):
        return self.filename

class CaptureComments(models.Model):
    capture   = models.ForeignKey(Capture, on_delete=models.CASCADE)
    framenum  = models.PositiveIntegerField()
    comment   = models.CharField(max_length=1024)

    def __str__(self):
        return "Comment frame #" + str(self.framenum) + " for " + str(self.capture)

class CaptureSettings(models.Model):
    capture = models.ForeignKey(Capture, on_delete=models.CASCADE)
    var     = models.CharField(max_length=128)
    value   = models.CharField(max_length=1024)

    def __str__(self):
        return "Setting " + self.var + " for " + str(self.capture)
