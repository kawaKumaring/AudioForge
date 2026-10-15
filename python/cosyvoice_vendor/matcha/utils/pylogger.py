# AudioForge: single-process inference logger; upstream MIT license retained.
import logging
def get_pylogger(name=__name__):
    return logging.getLogger(name)
