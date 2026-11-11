# Upstream retry budget
A failed upstream call is retried at most three times, with a fixed pause of two hundred and fifty milliseconds between attempts. Retries are issued only for idempotent methods.
