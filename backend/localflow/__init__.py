"""officev2 engine.

The numeric libraries (numpy, onnx, opencv) start one helper thread per CPU core and each reserves memory
for it when they are first imported. In every worker process that adds up, and on a computer with little free
memory the start-up fails ("OpenBLAS error: Memory allocation still failed") and the worker dies. One thread
each is plenty for this app, so it is set here, before anything imports them. A value set from outside wins.
"""
import os

for _name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_name, "1")
