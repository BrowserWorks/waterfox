/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WebRtcLog.h"

#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIFile.h"
#include "nsStringFwd.h"
#include "nsThreadUtils.h"
#include "nsXULAppAPI.h"
#include "nscore.h"
#include "rtc_base/logging.h"

#ifdef XP_WIN
#  include "nsNativeCharsetUtils.h"
#endif

using mozilla::LogLevel;

#define WEBRTC_LOG_MODULE_NAME "webrtc_trace"
#define WEBRTC_LOG_PREF "logging." WEBRTC_LOG_MODULE_NAME
static mozilla::LazyLogModule sWebRtcLog(WEBRTC_LOG_MODULE_NAME);

static webrtc::LoggingSeverity LevelToSeverity(mozilla::LogLevel aLevel) {
  switch (aLevel) {
    case mozilla::LogLevel::Verbose:
      return webrtc::LoggingSeverity::LS_VERBOSE;
    case mozilla::LogLevel::Debug:
    case mozilla::LogLevel::Info:
      return webrtc::LoggingSeverity::LS_INFO;
    case mozilla::LogLevel::Warning:
      return webrtc::LoggingSeverity::LS_WARNING;
    case mozilla::LogLevel::Error:
      return webrtc::LoggingSeverity::LS_ERROR;
    case mozilla::LogLevel::Disabled:
      return webrtc::LoggingSeverity::LS_NONE;
  }
  MOZ_ASSERT_UNREACHABLE("Unexpected log level");
  return webrtc::LoggingSeverity::LS_NONE;
}

static LogLevel SeverityToLevel(webrtc::LoggingSeverity aSeverity) {
  switch (aSeverity) {
    case webrtc::LoggingSeverity::LS_VERBOSE:
      return mozilla::LogLevel::Verbose;
    case webrtc::LoggingSeverity::LS_INFO:
      return mozilla::LogLevel::Debug;
    case webrtc::LoggingSeverity::LS_WARNING:
      return mozilla::LogLevel::Warning;
    case webrtc::LoggingSeverity::LS_ERROR:
      return mozilla::LogLevel::Error;
    case webrtc::LoggingSeverity::LS_NONE:
      return mozilla::LogLevel::Disabled;
  }
  MOZ_ASSERT_UNREACHABLE("Unexpected severity");
  return LogLevel::Disabled;
}

/**
 * Implementation of webrtc::LogSink that forwards RTC_LOG() to MOZ_LOG().
 */
class LogSinkImpl : public WebrtcLogSinkHandle, public webrtc::LogSink {
  NS_INLINE_DECL_REFCOUNTING(LogSinkImpl, override)

 public:
  static already_AddRefed<WebrtcLogSinkHandle> EnsureLogSink() {
    mozilla::AssertIsOnMainThread();
    if (sSingleton) {
      return do_AddRef(sSingleton);
    }
    return mozilla::MakeAndAddRef<LogSinkImpl>();
  }

  static void OnPrefChanged(const char* aPref, void* aData) {
    mozilla::AssertIsOnMainThread();
    MOZ_ASSERT(strcmp(aPref, WEBRTC_LOG_PREF) == 0);
    MOZ_ASSERT(aData == sSingleton);

    // Bounce to main thread again so the LogModule can settle on the new level
    // via its own observer.
    NS_DispatchToMainThread(mozilla::NewRunnableMethod(
        __func__, sSingleton, &LogSinkImpl::UpdateLogLevels));
  }

  LogSinkImpl() {
    mozilla::AssertIsOnMainThread();
    MOZ_RELEASE_ASSERT(!sSingleton);

    webrtc::LogMessage::AddLogToStream(this, LevelToSeverity(mLevel));
    sSingleton = this;

    mozilla::Preferences::RegisterCallbackAndCall(&LogSinkImpl::OnPrefChanged,
                                                  WEBRTC_LOG_PREF, this);
  }

 private:
  ~LogSinkImpl() {
    mozilla::AssertIsOnMainThread();
    MOZ_RELEASE_ASSERT(sSingleton == this);

    mozilla::Preferences::UnregisterCallback(&LogSinkImpl::OnPrefChanged,
                                             WEBRTC_LOG_PREF, this);
    webrtc::LogMessage::RemoveLogToStream(this);
    sSingleton = nullptr;
  }

  void UpdateLogLevels() {
    mozilla::AssertIsOnMainThread();
    mozilla::LogModule* webrtcModule = sWebRtcLog;
    mozilla::LogLevel webrtcLevel = webrtcModule->Level();

    if (webrtcLevel == mLevel) {
      return;
    }

    mLevel = webrtcLevel;

    webrtc::LogMessage::RemoveLogToStream(this);
    webrtc::LogMessage::AddLogToStream(this, LevelToSeverity(mLevel));
  }

  void OnLogMessage(const webrtc::LogLineRef& aLogLine) override {
    MOZ_LOG_FMT(sWebRtcLog, SeverityToLevel(aLogLine.severity()), "{}",
                aLogLine.DefaultLogLine().data());
  }

  void OnLogMessage(const std::string&) override {
    MOZ_CRASH(
        "Called overridden OnLogMessage that is inexplicably pure virtual");
  }

  static LogSinkImpl* sSingleton MOZ_GUARDED_BY(mozilla::sMainThreadCapability);
  LogLevel mLevel MOZ_GUARDED_BY(mozilla::sMainThreadCapability) =
      LogLevel::Disabled;
};

LogSinkImpl* LogSinkImpl::sSingleton = nullptr;

already_AddRefed<WebrtcLogSinkHandle> EnsureWebrtcLogging() {
  mozilla::AssertIsOnMainThread();
  return LogSinkImpl::EnsureLogSink();
}

nsCString ConfigAecLog() {
  nsCString aecLogDir;
  if (webrtc::LogMessage::aec_debug()) {
    return ""_ns;
  }
#if defined(ANDROID)
  const char* default_tmp_dir = "/dev/null";
  aecLogDir.Assign(default_tmp_dir);
#else
  nsCOMPtr<nsIFile> tempDir;
  nsresult rv = NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(tempDir));
  if (NS_SUCCEEDED(rv)) {
#  ifdef XP_WIN
    // WebRTC wants a path encoded in the native charset, not UTF-8.
    nsAutoString temp;
    tempDir->GetPath(temp);
    NS_CopyUnicodeToNative(temp, aecLogDir);
#  else
    tempDir->GetNativePath(aecLogDir);
#  endif
  }
#endif
  webrtc::LogMessage::set_aec_debug_filename(aecLogDir.get());

  return aecLogDir;
}

nsCString StartAecLog() {
  nsCString aecLogDir;
  if (webrtc::LogMessage::aec_debug()) {
    return ""_ns;
  }

  aecLogDir = ConfigAecLog();

  webrtc::LogMessage::set_aec_debug(true);

  return aecLogDir;
}

void StopAecLog() { webrtc::LogMessage::set_aec_debug(false); }
