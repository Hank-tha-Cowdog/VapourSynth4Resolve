// "Synthesizing clip…" overlay for the OFX host's screen.
//
// OFX offers no way to draw over the host's viewer, and the first render of a
// chain can block for tens of seconds (VapourSynth script evaluation +
// first-frame rendering). The host UI shows nothing in the meantime and looks
// frozen. This is a small borderless always-on-top panel the plugin shows
// while that first synthesis runs, and hides when the frame lands.
//
// ALL AppKit work — including the panel's creation — is confined to the
// host's main queue. NSWindow creation off the main thread throws, which
// unwound straight out of render() and silently failed every chain render.
// Render threads only enqueue show/hide blocks; if the main thread is busy
// the panel appears late or not at all — a courtesy indicator, never a
// correctness gate. overlay_panel is created and read only on the main queue.
#include <AppKit/AppKit.h>
#include <Foundation/Foundation.h>

namespace vsres {
namespace {

NSPanel* overlay_panel = nil;  // main-queue-confined.

void overlay_show_on_main() {
    if (overlay_panel == nil) {
        // Non-activating, non-focusable utility panel above ordinary windows.
        overlay_panel = [[NSPanel alloc] initWithContentRect:
            NSMakeRect(0, 0, 340, 92)
            styleMask:(NSWindowStyleMaskUtilityWindow | NSWindowStyleMaskNonactivatingPanel
                      | NSWindowStyleMaskTitled | NSWindowStyleMaskFullSizeContentView)
            backing:NSBackingStoreBuffered defer:YES];
        [overlay_panel setTitlebarAppearsTransparent:YES];
        [overlay_panel setTitleVisibility:NSWindowTitleHidden];
        [overlay_panel setLevel:NSFloatingWindowLevel + 2];
        [overlay_panel setCollectionBehavior:
            (NSWindowCollectionBehaviorCanJoinAllSpaces
             | NSWindowCollectionBehaviorFullScreenAuxiliary)];
        [overlay_panel setOpaque:NO];
        [overlay_panel setBackgroundColor:[NSColor clearColor]];
        [overlay_panel setIgnoresMouseEvents:YES];

        NSVisualEffectView* vibe = [[NSVisualEffectView alloc]
            initWithFrame:NSMakeRect(0, 0, 340, 92)];
        [vibe setMaterial:NSVisualEffectMaterialHUDWindow];
        [vibe setBlendingMode:NSVisualEffectBlendingModeBehindWindow];
        [vibe setState:NSVisualEffectStateActive];
        [[overlay_panel contentView] addSubview:vibe];

        NSTextField* label = [NSTextField labelWithString:@"Synthesizing clip…"];
        [label setFont:[NSFont systemFontOfSize:15 weight:NSFontWeightSemibold]];
        [label setTextColor:[NSColor whiteColor]];
        [label setAlignment:NSTextAlignmentCenter];
        [label setFrame:NSMakeRect(16, 46, 308, 30)];

        NSTextField* detail = [NSTextField labelWithString:
            @"VapourSynth is building the chain and rendering the first frames."];
        [detail setFont:[NSFont systemFontOfSize:11]];
        [detail setTextColor:[NSColor colorWithCalibratedWhite:1.0 alpha:0.75]];
        [detail setAlignment:NSTextAlignmentCenter];
        [detail setLineBreakMode:NSLineBreakByWordWrapping];
        [detail setFrame:NSMakeRect(16, 12, 308, 36)];

        [vibe addSubview:label];
        [vibe addSubview:detail];
    }
    // Position over the host (Resolve): top-center of the main screen,
    // just inside the menu-bar-safe visible area.
    NSRect frame = [overlay_panel frame];
    NSRect visible = [[NSScreen mainScreen] visibleFrame];
    CGFloat x = NSMidX(visible) - frame.size.width / 2.0;
    CGFloat top = NSMaxY(visible) - 16;
    [overlay_panel setFrameTopLeftPoint:NSMakePoint(x, top)];
    [overlay_panel orderFront:nil];
}

void overlay_hide_on_main() {
    if (overlay_panel == nil) return;
    [overlay_panel orderOut:nil];
}

}  // namespace

void overlay_show(const char* message) {
    (void)message;  // Reserved for a future per-call message; the panel has static copy.
    dispatch_async(dispatch_get_main_queue(), ^{
        overlay_show_on_main();
    });
}

void overlay_hide() {
    dispatch_async(dispatch_get_main_queue(), ^{
        overlay_hide_on_main();
    });
}

}  // namespace vsres