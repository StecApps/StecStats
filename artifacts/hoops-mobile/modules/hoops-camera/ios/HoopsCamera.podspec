require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'HoopsCamera'
  s.version = package['version']
  s.summary = 'Single-session AVCapture foundation for Hoops Stats'
  s.description = 'An Expo module that owns one AVCaptureSession for local preview and recording.'
  s.license = { :type => 'MIT' }
  s.author = { 'Hoops Stats' => 'support@hoopsstats.co' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.9'
  s.static_framework = true
  s.source = { :path => '.' }
  s.dependency 'ExpoModulesCore'
  # WebRTC is intentionally not a pod dependency here. The patched
  # react-native-webrtc module observes HoopsCamera's sample-buffer boundary,
  # keeping JitsiWebRTC linked exactly once.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
  s.source_files = '**/*.{h,m,mm,swift}'
end