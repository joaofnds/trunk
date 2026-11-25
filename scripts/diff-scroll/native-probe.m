#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <sys/socket.h>
#import <sys/un.h>
#import <sys/stat.h>
#import <unistd.h>
#import <mach/mach_time.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property dispatch_queue_t queue;
@property(copy) NSString *name;
@property unsigned int maxPixelsWide;
@property unsigned int maxPixelsHigh;
@property CGSize sizeInMillimeters;
@property unsigned int vendorID;
@property unsigned int productID;
@property unsigned int serialNum;
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property unsigned int hiDPI;
@property(copy) NSArray *modes;
@end
@interface CGVirtualDisplay : NSObject
@property(readonly) unsigned int displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end
static CGVirtualDisplay *probeDisplay;
static const unsigned int ProbeDisplaySerial = 0x0001;

@interface WKPreferences (ContractProbe)
+ (NSArray *)_features;
- (BOOL)_isEnabledForFeature:(id)feature;
@end

@interface NSObject (ContractFeatureKey)
- (NSString *)key;
@end

@interface WKWebView (ProcessProbe)
- (pid_t)_webProcessIdentifier;
- (pid_t)_gpuProcessIdentifier;
@end

@interface NSEvent (ProbeRelative)
- (NSEvent *)_eventRelativeToWindow:(NSWindow *)window;
@end

static WKWebView *findWebView(NSView *root) {
    if ([root isKindOfClass:WKWebView.class]) return (WKWebView *)root;
    for (NSView *view in root.subviews) {
        WKWebView *found = findWebView(view);
        if (found) return found;
    }
    return nil;
}

static WKWebView *webView(void) {
    for (NSWindow *window in NSApp.windows) {
        WKWebView *found = findWebView(window.contentView);
        if (found) return found;
    }
    return nil;
}

static NSDictionary *sendWheel(WKWebView *view, NSDictionary *input) {
    double dy = [input[@"dy"] doubleValue];
    double x = [input[@"x"] doubleValue];
    double y = [input[@"y"] doubleValue];
    NSPoint local = NSMakePoint(x, view.isFlipped ? y : view.bounds.size.height - y);
    NSPoint inWindow = [view convertPoint:local toView:nil];
    NSPoint global = [view.window convertPointToScreen:inWindow];
    CGFloat screenHeight = CGDisplayBounds(CGMainDisplayID()).size.height;
    CGEventRef cg = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 1, (int32_t)dy);
    CGEventSetLocation(cg, CGPointMake(global.x, screenHeight - global.y));
    CGEventSetIntegerValueField(cg, kCGMouseEventWindowUnderMousePointer, view.window.windowNumber);
    CGEventSetIntegerValueField(cg, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent, view.window.windowNumber);
    CGEventSetIntegerValueField(cg, kCGEventTargetUnixProcessID, getpid());
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventIsContinuous, 1);
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventScrollPhase, [input[@"phase"] longLongValue]);
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventMomentumPhase, [input[@"momentum"] longLongValue]);
    NSEvent *event = [[NSEvent eventWithCGEvent:cg] _eventRelativeToWindow:view.window];
    uint64_t sentAt = mach_absolute_time();
    [view scrollWheel:event];
    NSDictionary *result = @{@"deltaY": @(event.scrollingDeltaY), @"phase": @(event.phase),
        @"momentum": @(event.momentumPhase), @"windowNumber": @(event.windowNumber),
        @"locationX": @(event.locationInWindow.x), @"locationY": @(event.locationInWindow.y),
        @"machTicks": [NSString stringWithFormat:@"%llu", sentAt]};
    CFRelease(cg);
    return result;
}

static void execute(NSDictionary *request, void (^done)(NSDictionary *)) {
    WKWebView *view = webView();
    if (!view) { done(@{@"error": @"no WKWebView"}); return; }
    NSString *op = request[@"op"];
    if ([op isEqual:@"configuration-contract"]) {
        WKWebViewConfiguration *configuration = view.configuration;
        WKWebsiteDataStore *store = configuration.websiteDataStore;
        WKPreferences *preferences = configuration.preferences;
        BOOL hasIdentifier = [store respondsToSelector:@selector(identifier)];
        id identifier = hasIdentifier ? (store.identifier.UUIDString ?: NSNull.null) : NSNull.null;
        id near60 = NSNull.null;
        BOOL featureAvailable = NO;
        BOOL featuresAvailable = [WKPreferences respondsToSelector:@selector(_features)];
        BOOL readerAvailable = [preferences respondsToSelector:@selector(_isEnabledForFeature:)];
        if (featuresAvailable && readerAvailable) {
            for (id feature in [WKPreferences _features]) {
                if ([feature respondsToSelector:@selector(key)] &&
                    [[feature key] isEqual:@"PreferPageRenderingUpdatesNear60FPSEnabled"]) {
                    featureAvailable = YES;
                    near60 = @([preferences _isEnabledForFeature:feature]);
                    break;
                }
            }
        }
        done(@{@"persistent": @(store.persistent),
               @"identifierSupported": @(hasIdentifier),
               @"identifier": identifier,
               @"featureAvailable": @(featureAvailable),
               @"preferNear60": near60});
        return;
    }
    if ([op isEqual:@"processes"]) {
        if (![view respondsToSelector:@selector(_webProcessIdentifier)] || ![view respondsToSelector:@selector(_gpuProcessIdentifier)]) {
            done(@{@"error": @"process identifiers unavailable"}); return;
        }
        done(@{@"host": @(getpid()), @"web": @([view _webProcessIdentifier]), @"gpu": @([view _gpuProcessIdentifier])});
        return;
    }
    if (([op isEqual:@"wheel"] || [op isEqual:@"sequence"]) &&
        ![NSEvent instancesRespondToSelector:@selector(_eventRelativeToWindow:)]) {
        done(@{@"error": @"window-relative NSEvent API unavailable"});
        return;
    }
    if ([op isEqual:@"info"]) {
        done(@{@"pid": @(getpid()), @"window": @(view.window.windowNumber),
            @"width": @(view.bounds.size.width), @"height": @(view.bounds.size.height),
            @"visible": @(view.window.visible), @"occlusion": @(view.window.occlusionState),
            @"displayID": @([view.window.screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue]),
            @"maximumFramesPerSecond": @(view.window.screen.maximumFramesPerSecond),
            @"screen": @(view.window.screen.frame.origin.x), @"frame": NSStringFromRect(view.window.frame)});
        return;
    }
    if ([op isEqual:@"virtual-display"]) {
        id requested = request[@"refreshRate"];
        if (requested && ![requested isKindOfClass:NSNumber.class]) {
            done(@{@"error": @"refreshRate must be 60 or 120"}); return;
        }
        double refreshRate = requested ? [requested doubleValue] : 60;
        if (refreshRate != 60 && refreshRate != 120) {
            done(@{@"error": @"refreshRate must be 60 or 120"}); return;
        }
        CGVirtualDisplayDescriptor *descriptor = [NSClassFromString(@"CGVirtualDisplayDescriptor") new];
        if (!descriptor) { done(@{@"error":@"CGVirtualDisplayDescriptor unavailable"}); return; }
        descriptor.queue = dispatch_get_main_queue();
        descriptor.name = @"Trunk Blank Investigation";
        descriptor.maxPixelsWide = 1280;
        descriptor.maxPixelsHigh = 800;
        descriptor.sizeInMillimeters = CGSizeMake(320,200);
        descriptor.vendorID = 0xF0F0;
        descriptor.productID = 0xB1A0;
        descriptor.serialNum = ProbeDisplaySerial;
        probeDisplay = nil;
        probeDisplay = [[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
        CGVirtualDisplaySettings *settings = [NSClassFromString(@"CGVirtualDisplaySettings") new];
        settings.hiDPI = 0;
        settings.modes = @[[[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:1280 height:800 refreshRate:refreshRate]];
        BOOL applied = [probeDisplay applySettings:settings];
        if (!applied) { probeDisplay = nil; done(@{@"error": @"virtual display creation failed"}); return; }
        CGDisplayModeRef mode = CGDisplayCopyDisplayMode(probeDisplay.displayID);
        double actualRefreshRate = mode ? CGDisplayModeGetRefreshRate(mode) : 0;
        if (mode) CGDisplayModeRelease(mode);
        done(@{@"displayID":@(probeDisplay.displayID), @"applied":@(applied),
            @"requestedRefreshRate":@(refreshRate), @"actualRefreshRate":@(actualRefreshRate)});
        return;
    }
    if ([op isEqual:@"place-on-main-display"]) {
        CGDirectDisplayID displayID = CGMainDisplayID();
        NSScreen *main = nil;
        for (NSScreen *screen in NSScreen.screens) {
            if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == displayID) {
                main = screen;
                break;
            }
        }
        if (!main || (probeDisplay && displayID == probeDisplay.displayID)) {
            done(@{@"error": @"main display unavailable"}); return;
        }
        NSRect available = main.visibleFrame;
        CGFloat width = MIN(1280, available.size.width);
        CGFloat height = MIN(800, available.size.height);
        NSRect frame = NSMakeRect(available.origin.x + MIN(40, available.size.width - width),
                                 available.origin.y + MIN(40, available.size.height - height), width, height);
        [view.window setFrame:frame display:YES];
        [view.window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        done(@{@"frame": NSStringFromRect(view.window.frame), @"mainDisplay": @YES, @"builtIn": @(CGDisplayIsBuiltin(displayID)),
            @"displayID": @(displayID), @"maximumFramesPerSecond": @(main.maximumFramesPerSecond)});
        return;
    }
    if ([op isEqual:@"place-on-virtual-display"]) {
        for (NSScreen *screen in NSScreen.screens) {
            if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == probeDisplay.displayID) {
                [view.window setFrame:screen.frame display:YES];
                [view.window orderBack:nil];
                done(@{@"frame":NSStringFromRect(view.window.frame),@"screen":@(probeDisplay.displayID)});
                return;
            }
        }
        done(@{@"error":@"virtual display not present in NSScreen"});
        return;
    }
    if ([op isEqual:@"wheel"]) { done(sendWheel(view, request)); return; }
    if ([op isEqual:@"sequence"]) {
        NSArray *events = request[@"events"];
        if (events.count == 0 || events.count > 2000) { done(@{@"error": @"events must contain 1..2000 entries"}); return; }
        double lastTime = -1;
        for (NSDictionary *event in events) {
            double time = [event[@"atMs"] doubleValue];
            if (time < lastTime || time > 30000) { done(@{@"error": @"times must increase and finish within 30 seconds"}); return; }
            lastTime = time;
        }
        NSMutableArray *results = [NSMutableArray array];
        __block NSUInteger index = 0;
        __block dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, DISPATCH_TIMER_STRICT, dispatch_get_main_queue());
        uint64_t startLowerBound = mach_absolute_time();
        dispatch_time_t start = dispatch_time(DISPATCH_TIME_NOW, 0);
        uint64_t startUpperBound = mach_absolute_time();

        dispatch_source_set_event_handler(timer, ^{
            [results addObject:sendWheel(view, events[index])];
            index++;
            if (index == events.count) {
                dispatch_source_cancel(timer);
                timer = nil;

                mach_timebase_info_data_t timebase;
                mach_timebase_info(&timebase);

                done(@{@"sent": @(results.count), @"first": results.firstObject, @"last": results.lastObject,
                    @"plannedStartMachTicksLowerBound": [NSString stringWithFormat:@"%llu", startLowerBound],
                    @"plannedStartMachTicksUpperBound": [NSString stringWithFormat:@"%llu", startUpperBound],
                    @"events": results, @"timebaseNumer": @(timebase.numer), @"timebaseDenom": @(timebase.denom)});
            } else {
                dispatch_source_set_timer(timer, dispatch_time(start, [events[index][@"atMs"] doubleValue] * NSEC_PER_MSEC), DISPATCH_TIME_FOREVER, 0);
            }
        });
        dispatch_source_set_timer(timer, dispatch_time(start, [events[0][@"atMs"] doubleValue] * NSEC_PER_MSEC), DISPATCH_TIME_FOREVER, 0);
        dispatch_resume(timer);
        return;
    }
    done(@{@"error": @"unknown operation"});
}

__attribute__((destructor)) static void stopProbe(void) {
    probeDisplay = nil;
}

__attribute__((constructor)) static void startProbe(void) {
    unsetenv("DYLD_INSERT_LIBRARIES");
    const char *dir = getenv("TRUNK_DRIVE_DIR");
    if (!dir) return;
    NSString *path = [[NSString stringWithUTF8String:dir] stringByAppendingPathComponent:@"native.sock"];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        int listener = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un address = { .sun_family = AF_UNIX };
        strlcpy(address.sun_path, path.fileSystemRepresentation, sizeof(address.sun_path));
        if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(listener, 8) != 0) { perror("native probe bind"); return; }
        chmod(path.fileSystemRepresentation, 0600);
        for (;;) {
            int client = accept(listener, NULL, NULL);
            if (client < 0) break;
            @autoreleasepool {
                struct timeval timeout = { .tv_sec = 35 };
                setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
                NSMutableData *data = [NSMutableData data];
                char byte;
                while (data.length < 256000 && read(client, &byte, 1) == 1 && byte != '\n') [data appendBytes:&byte length:1];
                NSDictionary *request = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                dispatch_semaphore_t completed = dispatch_semaphore_create(0);
                __block NSDictionary *response;
                dispatch_async(dispatch_get_main_queue(), ^{
                    execute(request, ^(NSDictionary *value) { response = value; dispatch_semaphore_signal(completed); });
                });
                if (dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 35 * NSEC_PER_SEC)) != 0) response = @{@"error": @"main thread timed out"};
                NSData *encoded = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
                write(client, encoded.bytes, encoded.length);
                write(client, "\n", 1);
                close(client);
            }
        }
    });
}
