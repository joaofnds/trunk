import AppKit
import ScreenCaptureKit
import AVFoundation

struct CapturedFrame: Encodable {
    let frame: Int
    let seconds: Double
    let status: Int
    let displayMachTicks: String
}

struct CaptureReport: Encodable {
    let frames: Int
    let droppedFrames: Int
    let invalidFrames: Int
    let streamError: String
    let statuses: [String: Int]
    let samples: [CapturedFrame]
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let framesURL: URL
    var first: CMTime?
    var frames = 0
    var droppedFrames = 0
    var invalidFrames = 0
    var streamError: String?
    var statuses: [Int: Int] = [:]
    var samples: [CapturedFrame] = []
    let queue = DispatchQueue(label: "trunk.blank.capture")

    init(output: URL, width: Int, height: Int) throws {
        framesURL = output.appendingPathExtension("json")
        writer = try AVAssetWriter(outputURL: output, fileType: .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 12000000]
        ])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        writer.startWriting()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }

        guard buffer.isValid else {
            invalidFrames += 1
            return
        }

        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [NSDictionary],
              let raw = attachments.first?[SCStreamFrameInfo.status.rawValue] as? Int else {
            invalidFrames += 1
            return
        }

        statuses[raw, default: 0] += 1
        guard raw == SCFrameStatus.complete.rawValue else { return }

        guard let displayTicks = attachments.first?[SCStreamFrameInfo.displayTime.rawValue] as? UInt64,
              displayTicks > 0 else {
            invalidFrames += 1
            return
        }

        if first == nil { first = time; writer.startSession(atSourceTime: time) }

        guard input.isReadyForMoreMediaData, input.append(buffer) else {
            droppedFrames += 1
            return
        }

        frames += 1
        samples.append(CapturedFrame(frame: frames, seconds: CMTimeGetSeconds(time - first!),
                                     status: raw, displayMachTicks: String(displayTicks)))
        if frames == 1 {
            print("READY first-frame \(displayTicks)")
            fflush(stdout)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        recordError(error.localizedDescription)
        fputs("capture stopped: \(error)\n", stderr)
    }

    func recordError(_ message: String) {
        queue.async { self.streamError = message }
    }

    func finish() async throws {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async { self.input.markAsFinished(); self.writer.finishWriting { continuation.resume() } }
        }
        let report = CaptureReport(frames: frames, droppedFrames: droppedFrames, invalidFrames: invalidFrames,
            streamError: streamError ?? "", statuses: statuses.mapKeys(), samples: samples)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(report).write(to: framesURL)
        print("captured \(frames) complete frames; status \(writer.status.rawValue); \(framesURL.path)")
        if let error = writer.error { throw error }
    }
}

extension Dictionary where Key == Int, Value == Int {
    func mapKeys() -> [String: Int] { Dictionary<String, Int>(uniqueKeysWithValues: map { (String($0.key), $0.value) }) }
}

@main struct Main {
    static func main() async throws {
        _ = NSApplication.shared
        guard CommandLine.arguments.count == 4,
              let windowID = UInt32(CommandLine.arguments[1]),
              let seconds = Double(CommandLine.arguments[3]), seconds > 0, seconds <= 30 else {
            fatalError("usage: native-capture WINDOW_ID OUTPUT.mov SECONDS (0..30)")
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else { fatalError("window not found") }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(window.frame.width)
        configuration.height = Int(window.frame.height)
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 120)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 6
        configuration.showsCursor = false
        configuration.capturesAudio = false
        let capture = try Capture(output: URL(fileURLWithPath: CommandLine.arguments[2]), width: configuration.width, height: configuration.height)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: capture)
        try stream.addStreamOutput(capture, type: .screen, sampleHandlerQueue: capture.queue)
        try await stream.startCapture()
        try await Task.sleep(for: .seconds(seconds))
        do { try await stream.stopCapture() }
        catch { capture.recordError(error.localizedDescription) }
        try await capture.finish()
    }
}
