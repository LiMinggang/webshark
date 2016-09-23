from django.db import models

class Capture(models.Model):
    filename = models.CharField(max_length=256)
    description = models.CharField(max_length=512)
    analysis = models.TextField()

    def __str__(self):
        return self.filename
