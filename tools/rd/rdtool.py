# RenderDoc replay queries, run inside qrenderdoc's embedded Python by tools/rd.mjs:
#   qrenderdoc --python tools/rd/rdtool.py
# Arguments arrive in environment variables (qrenderdoc passes none to the script):
#   RD_CMD    actions | pick | debug
#   RD_CAP    capture file
#   RD_EID    event id (pick, debug)
#   RD_X, RD_Y  pixel; RD_Y may be a range "y0:y1" for pick
#   RD_FILTER   comma-separated substrings of local-variable names to report (debug)
#   RD_OUT    result file (plain text)
import os
import traceback

import renderdoc as rd

out = open(os.environ["RD_OUT"], "w")


def p(*a):
    out.write(" ".join(str(x) for x in a) + "\n")
    out.flush()


def ok(res):
    # RenderDoc 1.47 returns ResultDetails objects; older versions return ResultCode
    return res.OK() if hasattr(res, "OK") else res == rd.ResultCode.Succeeded


def fmt(v, c):
    t = v.type
    if t in (rd.VarType.Float, rd.VarType.Half, rd.VarType.Double):
        return float("%.6g" % v.value.f32v[c])
    if t in (rd.VarType.SInt, rd.VarType.SShort, rd.VarType.SByte):
        return v.value.s32v[c]
    return v.value.u32v[c]


def actions(ctrl):
    sf = ctrl.GetStructuredFile()

    def walk(acts, depth):
        for a in acts:
            kinds = [n for n in ("Drawcall", "Dispatch", "Clear", "Copy", "Present")
                     if a.flags & getattr(rd.ActionFlags, n)]
            if kinds:
                p("%s[%d] %s %s verts=%d inst=%d" % ("  " * depth, a.eventId, a.GetName(sf), kinds,
                                                     a.numIndices, a.numInstances))
            walk(a.children, depth + 1)

    walk(ctrl.GetRootActions(), 0)


def pick(ctrl, eid, x, ys):
    ctrl.SetFrameEvent(eid, True)
    targets = ctrl.GetPipelineState().GetOutputTargets()
    for y in ys:
        row = []
        for i, t in enumerate(targets):
            if t.resource == rd.ResourceId.Null():
                continue
            f = ctrl.PickPixel(t.resource, x, y, rd.Subresource(0, 0, 0), rd.CompType.Typeless).floatValue
            row.append("rt%d=(%.3f %.3f %.3f %.3f)" % (i, f[0], f[1], f[2], f[3]))
        p("(%d,%d) %s" % (x, y, " ".join(row)))


def debug(ctrl, eid, x, y, filters):
    ctrl.SetFrameEvent(eid, True)
    trace = ctrl.DebugPixel(x, y, rd.DebugPixelInputs())
    if trace is None or trace.debugger is None:
        p("no fragment at (%d,%d) for event %d (discarded, or shader not debuggable)" % (x, y, eid))
        return
    by_inst = {ii.instruction: ii for ii in trace.instInfo}
    vals = {}
    named = {}
    steps = 0
    while True:
        states = ctrl.ContinueDebug(trace.debugger)
        if not states:
            break
        for st in states:
            for ch in st.changes:
                vals[ch.after.name] = ch.after
            ii = by_inst.get(st.nextInstruction)
            if ii is None:
                continue
            for sv in ii.sourceVars:
                got = []
                for ref in sv.variables:
                    v = vals.get(ref.name)
                    if v is not None and ref.type == rd.DebugVariableType.Variable:
                        got.append(fmt(v, ref.component))
                if got:
                    named[sv.name] = got
        steps += len(states)
    ctrl.FreeTrace(trace)
    p("steps %d, named locals %d (values are each local's last assignment)" % (steps, len(named)))
    for k in sorted(named):
        if not filters or any(f in k for f in filters):
            p("  %s = %s" % (k, named[k][:8]))


try:
    cmd = os.environ["RD_CMD"]
    cap = rd.OpenCaptureFile()
    if not ok(cap.OpenFile(os.environ["RD_CAP"], "", None)):
        raise RuntimeError("cannot open " + os.environ["RD_CAP"])
    res, ctrl = cap.OpenCapture(rd.ReplayOptions(), None)
    if not ok(res):
        raise RuntimeError("cannot replay: %s" % res)
    if cmd == "actions":
        actions(ctrl)
    elif cmd == "pick":
        ys = os.environ["RD_Y"]
        if ":" in ys:
            a, b = (int(s) for s in ys.split(":"))
            yr = range(a, b)
        else:
            yr = [int(ys)]
        pick(ctrl, int(os.environ["RD_EID"]), int(os.environ["RD_X"]), yr)
    elif cmd == "debug":
        filters = [f for f in os.environ.get("RD_FILTER", "").split(",") if f]
        debug(ctrl, int(os.environ["RD_EID"]), int(os.environ["RD_X"]), int(os.environ["RD_Y"]), filters)
    else:
        p("unknown RD_CMD " + cmd)
    ctrl.Shutdown()
    cap.Shutdown()
except Exception:
    p("ERROR " + traceback.format_exc())
out.close()
os._exit(0)
