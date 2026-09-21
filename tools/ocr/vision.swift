import Foundation
import Vision
import AppKit
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let image = NSImage(data:data), let cg = image.cgImage(forProposedRect:nil,context:nil,hints:nil) else { exit(2) }
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US", "ru-RU"]
req.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage:cg).perform([req])
var rows:[[String:Any]] = []
for obs in req.results ?? [] {
  guard let c = obs.topCandidates(1).first else {continue}
  let b = obs.boundingBox
  rows.append(["text":c.string,"confidence":c.confidence,"box":[b.minX*1000,(1-b.maxY)*1000,b.width*1000,b.height*1000]])
}
let output = try JSONSerialization.data(withJSONObject:rows)
FileHandle.standardOutput.write(output)
