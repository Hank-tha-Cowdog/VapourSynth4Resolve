#pragma once

// "Synthesizing clip…" courtesy overlay (see render_overlay.mm). Never a
// correctness gate: if the host main queue is blocked, the panel just does
// not appear. Show/hide may be called from any thread.

namespace vsres {

void overlay_show(const char* message);
void overlay_hide();

}  // namespace vsres