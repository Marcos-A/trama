// Opens a video file with AVFoundation, the framework QuickTime Player uses, and decodes every
// track to the end. Prints JSON: whether AVFoundation calls it playable, its duration, and per
// track the codec, how much decoded, and whether the reader finished cleanly. macOS only; used by
// the browser tests on macOS (tests/helpers/avfoundation.ts) for manual checks 8a/8c ("plays in
// QuickTime").
//
//   swift scripts/avfoundation-check.swift <file>

import AVFoundation
import Foundation

func fourCC(_ code: FourCharCode) -> String {
  let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }
  return String(bytes: bytes, encoding: .ascii) ?? "\(code)"
}

let path = CommandLine.arguments[1]
let asset = AVURLAsset(url: URL(fileURLWithPath: path))
var result: [String: Any] = ["file": path]
do {
  result["playable"] = try await asset.load(.isPlayable)
  result["durationS"] = try await asset.load(.duration).seconds
  var tracks: [[String: Any]] = []
  for track in try await asset.load(.tracks) {
    var info: [String: Any] = ["type": track.mediaType.rawValue]
    if let desc = try await track.load(.formatDescriptions).first {
      info["codec"] = fourCC(CMFormatDescriptionGetMediaSubType(desc))
    }
    let range = try await track.load(.timeRange)
    info["startS"] = range.start.seconds
    info["durationS"] = range.duration.seconds
    // One reader per track: a single reader with several outputs has to be read interleaved.
    let reader = try AVAssetReader(asset: asset)
    let settings: [String: Any] =
      track.mediaType == .video
      ? [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
      : [AVFormatIDKey: kAudioFormatLinearPCM]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    reader.add(output)
    reader.startReading()
    var buffers = 0
    var endS = 0.0
    while let sample = output.copyNextSampleBuffer() {
      buffers += 1
      // Decoded video frames often carry no duration; fall back to the frame's start.
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      let duration = CMSampleBufferGetDuration(sample)
      let end = duration.isNumeric ? CMTimeAdd(pts, duration) : pts
      if end.isNumeric { endS = max(endS, end.seconds) }
    }
    info["decodedBuffers"] = buffers
    info["decodedToS"] = endS
    info["readerStatus"] = reader.status == .completed ? "completed" : "status \(reader.status.rawValue): \(reader.error?.localizedDescription ?? "")"
    tracks.append(info)
  }
  result["tracks"] = tracks
} catch {
  result["error"] = "\(error)"
}
let json = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
print(String(data: json, encoding: .utf8)!)
