import AudioToolbox
import Foundation

let sampleRate = Double(ProcessInfo.processInfo.environment["NARRATION_PCM_SAMPLE_RATE"] ?? "24000") ?? 24000
let channels: UInt32 = 1
let bytesPerSample = MemoryLayout<Float>.size
let bufferFrames = 2048
let bufferByteSize = bufferFrames * bytesPerSample * Int(channels)
let queueBufferCount = 3

final class PlayerState {
  let input = FileHandle.standardInput
  let lock = NSCondition()
  var queue: AudioQueueRef?
  var activeBuffers = 0
  var reachedEOF = false
}

func fail(_ message: String, _ status: OSStatus? = nil) -> Never {
  if let status {
    FileHandle.standardError.write(Data("\(message): \(status)\n".utf8))
  } else {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
  }
  exit(1)
}

let state = PlayerState()
var format = AudioStreamBasicDescription(
  mSampleRate: sampleRate,
  mFormatID: kAudioFormatLinearPCM,
  mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian,
  mBytesPerPacket: UInt32(bytesPerSample) * channels,
  mFramesPerPacket: 1,
  mBytesPerFrame: UInt32(bytesPerSample) * channels,
  mChannelsPerFrame: channels,
  mBitsPerChannel: UInt32(bytesPerSample * 8),
  mReserved: 0
)

let callback: AudioQueueOutputCallback = { userData, audioQueue, buffer in
  guard let userData else { return }
  let state = Unmanaged<PlayerState>.fromOpaque(userData).takeUnretainedValue()
  let data = state.input.readData(ofLength: Int(buffer.pointee.mAudioDataBytesCapacity))

  if data.isEmpty {
    state.lock.lock()
    state.activeBuffers -= 1
    state.reachedEOF = true
    if state.activeBuffers == 0 {
      AudioQueueStop(audioQueue, false)
      state.lock.signal()
    }
    state.lock.unlock()
    return
  }

  data.withUnsafeBytes { rawBuffer in
    if let baseAddress = rawBuffer.baseAddress {
      memcpy(buffer.pointee.mAudioData, baseAddress, data.count)
    }
  }
  buffer.pointee.mAudioDataByteSize = UInt32(data.count)

  let status = AudioQueueEnqueueBuffer(audioQueue, buffer, 0, nil)
  if status != noErr {
    state.lock.lock()
    state.activeBuffers -= 1
    state.reachedEOF = true
    state.lock.signal()
    state.lock.unlock()
  }
}

let userData = Unmanaged.passUnretained(state).toOpaque()
var queue: AudioQueueRef?
var status = AudioQueueNewOutput(&format, callback, userData, nil, nil, 0, &queue)
if status != noErr { fail("AudioQueueNewOutput failed", status) }
guard let queue else { fail("Audio queue was not created") }
state.queue = queue

for _ in 0..<queueBufferCount {
  var buffer: AudioQueueBufferRef?
  status = AudioQueueAllocateBuffer(queue, UInt32(bufferByteSize), &buffer)
  if status != noErr { fail("AudioQueueAllocateBuffer failed", status) }
  guard let buffer else { fail("Audio buffer was not created") }

  state.lock.lock()
  state.activeBuffers += 1
  state.lock.unlock()
  callback(userData, queue, buffer)
}

status = AudioQueueStart(queue, nil)
if status != noErr { fail("AudioQueueStart failed", status) }

state.lock.lock()
while !state.reachedEOF || state.activeBuffers > 0 {
  state.lock.wait()
}
state.lock.unlock()

AudioQueueDispose(queue, true)
