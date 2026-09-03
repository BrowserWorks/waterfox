/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsDragService.h"
#include "nsDragServiceGtk.h"
#ifdef MOZ_WAYLAND
#  include "nsDragServiceWayland.h"
#endif
#include "nsArrayUtils.h"
#include "nsComponentManagerUtils.h"
#include "nsIObserverService.h"
#include "nsWidgetsCID.h"
#include "nsWindow.h"
#include "nsSystemInfo.h"
#include "nsXPCOM.h"
#include "nsICookieJarSettings.h"
#include "nsISupportsPrimitives.h"
#include "nsIIOService.h"
#include "nsIFileURL.h"
#include "nsNetUtil.h"
#include "mozilla/Logging.h"
#include "nsTArray.h"
#include "nsPrimitiveHelpers.h"
#include "prtime.h"
#include "prthread.h"
#include <dlfcn.h>
#include <mutex>
#include <gtk/gtk.h>
#include "nsCRT.h"
#include "mozilla/BasicEvents.h"
#include "mozilla/Services.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/PresShell.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/WidgetUtils.h"
#include "mozilla/WidgetUtilsGtk.h"
#include "mozilla/StaticPrefs_widget.h"
#include "GRefPtr.h"
#include "nsAppShell.h"
#ifdef MOZ_X11
#  include "gfxXlibSurface.h"
#endif
#include "gfxContext.h"
#include "nsImageToPixbuf.h"
#include "nsPresContext.h"
#include "nsIContent.h"
#include "mozilla/dom/Document.h"
#include "nsIFrame.h"
#include "nsGtkUtils.h"
#include "nsGtkKeyUtils.h"
#include "mozilla/widget/nsGtkHtmlUtils.h"
#include "mozilla/gfx/2D.h"
#include "gfxPlatform.h"
#include "ScreenHelperGTK.h"
#include "nsArrayUtils.h"
#include "nsStringStream.h"
#include "nsDirectoryService.h"
#include "nsDirectoryServiceDefs.h"
#include "nsEscape.h"
#include "nsString.h"

using namespace mozilla;
using namespace mozilla::widget;
using namespace mozilla::gfx;

//  The maximum time to wait before temporary files resulting
//  from drag'n'drop events will be removed in miliseconds.
//  It's set to 5 min as the file has to be present some time after drop
//  event to give target application time to get the data.
//  (A target application can throw a dialog to ask user what to do with
//  the data and will access the tmp file after user action.)
#define NS_DND_TMP_CLEANUP_TIMEOUT (1000 * 60 * 5)

#define NS_SYSTEMINFO_CONTRACTID "@mozilla.org/system-info;1"

// This sets how opaque the drag image is
#define DRAG_IMAGE_ALPHA_LEVEL 0.5

#ifdef MOZ_LOGGING
extern mozilla::LazyLogModule gWidgetDragLog;
#  define LOGDRAGSERVICE(str, ...)                                             \
    MOZ_LOG(                                                                   \
        gWidgetDragLog, mozilla::LogLevel::Debug,                              \
        ("[D %d]%s %*s" str, nsDragSession::GetLoopDepth(),                    \
         GetDebugTag().get(),                                                  \
         nsDragSession::GetLoopDepth() > 1 ? nsDragSession::GetLoopDepth() * 2 \
                                           : 0,                                \
         "", ##__VA_ARGS__))
#  define LOGDRAGSERVICESTATIC(str, ...) \
    MOZ_LOG(gWidgetDragLog, mozilla::LogLevel::Debug, (str, ##__VA_ARGS__))
#else
#  define LOGDRAGSERVICE(...)
#endif

// Helper class to block native events processing.
class MOZ_STACK_CLASS AutoSuspendNativeEvents {
 public:
  AutoSuspendNativeEvents() {
    mAppShell = do_GetService(NS_APPSHELL_CID);
    mAppShell->SuspendNative();
  }
  ~AutoSuspendNativeEvents() { mAppShell->ResumeNative(); }

 private:
  nsCOMPtr<nsIAppShell> mAppShell;
};

// data used for synthetic periodic motion events sent to the source widget
// grabbing real events for the drag.
static guint sMotionEventTimerID;

static GdkEvent* sMotionEvent;
static GUniquePtr<GdkEvent> TakeMotionEvent() {
  GUniquePtr<GdkEvent> event(sMotionEvent);
  sMotionEvent = nullptr;
  return event;
}
static void SetMotionEvent(GUniquePtr<GdkEvent> aEvent) {
  TakeMotionEvent();
  sMotionEvent = aEvent.release();
}

static GtkWidget* sGrabWidget;

static constexpr nsLiteralString kDisallowedExportedSchemes[] = {
    u"about"_ns,          u"blob"_ns,        u"cached-favicon"_ns,
    u"chrome"_ns,         u"imap"_ns,        u"javascript"_ns,
    u"mailbox"_ns,        u"news"_ns,        u"page-icon"_ns,
    u"resource"_ns,       u"view-source"_ns, u"moz-extension"_ns,
    u"moz-page-thumb"_ns,
};

// _NETSCAPE_URL is similar to text/uri-list type.
// Format is UTF8: URL + "\n" + title.
// While text/uri-list tells target application to fetch, copy and store data
// from URL, _NETSCAPE_URL suggest to create a link to the target.
// Also _NETSCAPE_URL points to only one item while text/uri-list can point to
// multiple ones.
static const char gMozUrlType[] = "_NETSCAPE_URL";
static const char gMimeListType[] = "application/x-moz-internal-item-list";
static const char gTextUriListType[] = "text/uri-list";
static const char gTextPlainUTF8Type[] = "text/plain;charset=utf-8";
static const char gXdndDirectSaveType[] = "XdndDirectSave0";
static const char gTabDropType[] = "application/x-moz-tabbrowser-tab";
static const char gPortalFile[] = "application/vnd.portal.files";
static const char gPortalFileTransfer[] = "application/vnd.portal.filetransfer";
static const char gUTF8STRINGType[] = "UTF8_STRING";
static const char gSTRINGType[] = "STRING";

GdkAtom nsDragSession::sJPEGImageMimeAtom;
GdkAtom nsDragSession::sJPGImageMimeAtom;
GdkAtom nsDragSession::sPNGImageMimeAtom;
GdkAtom nsDragSession::sGIFImageMimeAtom;
GdkAtom nsDragSession::sCustomTypesMimeAtom;
GdkAtom nsDragSession::sURLMimeAtom;
GdkAtom nsDragSession::sRTFMimeAtom;
GdkAtom nsDragSession::sTextMimeAtom;
GdkAtom nsDragSession::sMozUrlTypeAtom;
GdkAtom nsDragSession::sMimeListTypeAtom;
GdkAtom nsDragSession::sTextUriListTypeAtom;
GdkAtom nsDragSession::sTextPlainUTF8TypeAtom;
GdkAtom nsDragSession::sXdndDirectSaveTypeAtom;
GdkAtom nsDragSession::sTabDropTypeAtom;
GdkAtom nsDragSession::sFileMimeAtom;
GdkAtom nsDragSession::sPortalFileAtom;
GdkAtom nsDragSession::sPortalFileTransferAtom;
GdkAtom nsDragSession::sFilePromiseURLMimeAtom;
GdkAtom nsDragSession::sFilePromiseMimeAtom;
GdkAtom nsDragSession::sNativeImageMimeAtom;
GdkAtom nsDragSession::sUTF8STRINGMimeAtom;
GdkAtom nsDragSession::sSTRINGMimeAtom;

// See https://docs.gtk.org/gtk3/enum.DragResult.html
static const char kGtkDragResults[][100]{
    "GTK_DRAG_RESULT_SUCCESS",        "GTK_DRAG_RESULT_NO_TARGET",
    "GTK_DRAG_RESULT_USER_CANCELLED", "GTK_DRAG_RESULT_TIMEOUT_EXPIRED",
    "GTK_DRAG_RESULT_GRAB_BROKEN",    "GTK_DRAG_RESULT_ERROR"};

static void invisibleSourceDragBegin(GtkWidget* aWidget,
                                     GdkDragContext* aContext, gpointer aData);

static void invisibleSourceDragEnd(GtkWidget* aWidget, GdkDragContext* aContext,
                                   gpointer aData);

static gboolean invisibleSourceDragFailed(GtkWidget* aWidget,
                                          GdkDragContext* aContext,
                                          gint aResult, gpointer aData);

static void invisibleSourceDragDataGet(GtkWidget* aWidget,
                                       GdkDragContext* aContext,
                                       GtkSelectionData* aSelectionData,
                                       guint aInfo, guint32 aTime,
                                       gpointer aData);

static void UTF16ToNewUTF8(const char16_t* aUTF16, uint32_t aUTF16Len,
                           char** aUTF8, uint32_t* aUTF8Len) {
  nsDependentSubstring utf16(aUTF16, aUTF16Len);
  *aUTF8 = ToNewUTF8String(utf16, aUTF8Len);
}

static nsString UTF8ToNewString(const char* aUTF8, uint32_t aUTF8DataLen = 0) {
  nsDependentCSubstring utf8(aUTF8,
                             aUTF8DataLen ? aUTF8DataLen : strlen(aUTF8));
  nsString ret;
  uint32_t convertedTextLen = 0;
  char16_t* convertedText = UTF8ToNewUnicode(utf8, &convertedTextLen);
  if (!convertedText) {
    return ret;
  }
  convertedTextLen *= 2;

  // Strip CRLF which might be present in the string.
  // Not sure where it's added, maybe Gtk?
  nsLinebreakHelpers::ConvertPlatformToDOMLinebreaks(
      /*  aIsSingleByteChars */ false, (void**)&convertedText,
      (int32_t*)&convertedTextLen);
  ret.Adopt(convertedText, convertedTextLen / 2);
  return ret;
}

static bool GetFileFromUri(const nsCString& aUri, nsCOMPtr<nsIFile>& aFile) {
  nsresult rv;
  nsCOMPtr<nsIIOService> ioService = do_GetIOService(&rv);
  nsCOMPtr<nsIURI> fileURI;
  if (NS_SUCCEEDED(
          ioService->NewURI(aUri, nullptr, nullptr, getter_AddRefs(fileURI)))) {
    nsCOMPtr<nsIFileURL> fileURL = do_QueryInterface(fileURI, &rv);
    if (NS_SUCCEEDED(rv)) {
      if (NS_SUCCEEDED(fileURL->GetFile(getter_AddRefs(aFile)))) {
        return true;
      }
    }
  }

  LOGDRAG("GetFileFromUri() failed");
  return false;
}

bool DragData::IsImageFlavor() const {
  return mDataFlavor == nsDragSession::sJPEGImageMimeAtom ||
         mDataFlavor == nsDragSession::sJPGImageMimeAtom ||
         mDataFlavor == nsDragSession::sPNGImageMimeAtom ||
         mDataFlavor == nsDragSession::sGIFImageMimeAtom;
}

bool DragData::IsFileFlavor() const {
  return mDataFlavor == nsDragSession::sFileMimeAtom ||
         mDataFlavor == nsDragSession::sPortalFileAtom ||
         mDataFlavor == nsDragSession::sPortalFileTransferAtom;
}

bool DragData::IsTextFlavor() const {
  return nsDragSession::IsTextFlavor(mDataFlavor);
}

bool DragData::IsURIFlavor() const {
  // We support x-moz-url URL MIME type only
  return mDataFlavor == nsDragSession::sURLMimeAtom;
}

int DragData::GetURIsNum() const {
  int urlNum = 1;
  if (mDragUris) {
    urlNum = g_strv_length(mDragUris.get());
  } else if (IsURIFlavor()) {
    urlNum = mUris.Length();
  }
  LOGDRAG("DragData::GetURIsNum() %d", urlNum);
  return urlNum;
}

bool DragData::Export(nsITransferable* aTransferable, uint32_t aItemIndex) {
  GUniquePtr<gchar> flavorName(gdk_atom_name(mDataFlavor));

  LOGDRAG("DragData::Export() MIME %s index %d", flavorName.get(), aItemIndex);

  if (IsFileFlavor()) {
    MOZ_ASSERT(mDragUris.get());

    char** list = mDragUris.get();
    if (aItemIndex >= g_strv_length(list)) {
      NS_WARNING(
          nsPrintfCString(
              "DragData::Export(): Index %d is overflow file list len %d",
              aItemIndex, g_strv_length(list))
              .get());
      return false;
    }
    bool fileExists = false;
    nsCOMPtr<nsIFile> file;
    if (GetFileFromUri(nsDependentCString(list[aItemIndex]), file)) {
      file->Exists(&fileExists);
    }
    if (!fileExists) {
      LOGDRAG("  uri %s not reachable/not found\n", list[aItemIndex]);
      return false;
    }
    LOGDRAG("  export file %s (flavor: %s) as %s", list[aItemIndex],
            flavorName.get(), kFileMime);
    aTransferable->SetTransferData(kFileMime, file);
    return true;
  }

  if (IsURIFlavor()) {
    MOZ_ASSERT(mAsURIData);
    if (aItemIndex >= mUris.Length()) {
      NS_WARNING(nsPrintfCString(
                     "DragData::Export(): Index %d is overflow uri list len %d",
                     aItemIndex, (int)mUris.Length())
                     .get());
      return false;
    }

    LOGDRAG("%d URI:\n%s", (int)aItemIndex,
            NS_ConvertUTF16toUTF8(mUris[aItemIndex]).get());

    // put it into the transferable.
    nsCOMPtr<nsISupports> genericDataWrapper;
    nsPrimitiveHelpers::CreatePrimitiveForData(
        nsAutoCString(kURLMime), mUris[aItemIndex].get(),
        mUris[aItemIndex].Length() * 2, getter_AddRefs(genericDataWrapper));

    return NS_SUCCEEDED(
        aTransferable->SetTransferData(kURLMime, genericDataWrapper));
  }

  if (IsImageFlavor()) {
    LOGDRAG("  export image %s", flavorName.get());
    nsCOMPtr<nsIInputStream> byteStream;
    NS_NewByteInputStream(getter_AddRefs(byteStream),
                          mozilla::Span((char*)mDragData.get(), mDragDataLen),
                          NS_ASSIGNMENT_COPY);
    return NS_SUCCEEDED(
        aTransferable->SetTransferData(flavorName.get(), byteStream));
  }

  if (IsTextFlavor()) {
    LOGDRAG("  export text %s", kTextMime);

    // We get text flavors as UTF8 but we export them as UTF16.
    if (mData.IsEmpty() && mDragDataLen) {
      mData = UTF8ToNewString(static_cast<const char*>(mDragData.get()),
                              mDragDataLen);
    }

    // put it into the transferable.
    nsCOMPtr<nsISupports> genericDataWrapper;
    nsPrimitiveHelpers::CreatePrimitiveForData(
        nsAutoCString(kTextMime), mData.get(), mData.Length() * 2,
        getter_AddRefs(genericDataWrapper));

    return NS_SUCCEEDED(
        aTransferable->SetTransferData(kTextMime, genericDataWrapper));
  }

  // text/html from external apps arrives as raw bytes in a charset that may
  // not be UTF-16.  Detect and decode it just as the clipboard code does.
  if (nsDependentCString(flavorName.get()).EqualsLiteral(kHTMLMime) &&
      mDragData && mDragDataLen) {
    LOGDRAG("  export HTML, decoding charset");
    mozilla::Span<const char> span(static_cast<const char*>(mDragData.get()),
                                   mDragDataLen);
    nsAutoString unicodeData;
    if (!mozilla::widget::DecodeHTMLData(span, unicodeData)) {
      LOGDRAG("  failed to decode HTML data");
      return false;
    }
    nsCOMPtr<nsISupports> genericDataWrapper;
    nsPrimitiveHelpers::CreatePrimitiveForData(
        nsLiteralCString(kHTMLMime), (const char*)unicodeData.BeginReading(),
        unicodeData.Length() * sizeof(char16_t),
        getter_AddRefs(genericDataWrapper));
    return NS_SUCCEEDED(
        aTransferable->SetTransferData(kHTMLMime, genericDataWrapper));
  }

  // We export obtained data directly from Gtk. In such case only
  // update line endings to DOM format.
  if (!mDragDataDOMEndings &&
      mDataFlavor != nsDragSession::sCustomTypesMimeAtom) {
    mDragDataDOMEndings = true;
    void* tmpData = mDragData.release();
    nsLinebreakHelpers::ConvertPlatformToDOMLinebreaks(
        mDataFlavor == nsDragSession::sRTFMimeAtom, &tmpData,
        (int32_t*)&mDragDataLen);
    mDragData.reset(tmpData);
  }

  // put it into the transferable.
  nsCOMPtr<nsISupports> genericDataWrapper;
  nsPrimitiveHelpers::CreatePrimitiveForData(
      nsDependentCString(flavorName.get()), mDragData.get(), mDragDataLen,
      getter_AddRefs(genericDataWrapper));

  return NS_SUCCEEDED(
      aTransferable->SetTransferData(flavorName.get(), genericDataWrapper));
}

RefPtr<DragData> DragData::ConvertToMozURL() const {
  // "text/uri-list" is exported as URI mime type by Gtk, perhaps in UTF8.
  // We convert it to "text/x-moz-url" which is UTF16 with line breaks.
  if (mDataFlavor == nsDragSession::sTextUriListTypeAtom) {
    MOZ_ASSERT(mAsURIData && mDragUris);
    LOGDRAG("ConvertToMozURL(): text/uri-list => text/x-moz-url");

    RefPtr<DragData> data = new DragData(nsDragSession::sURLMimeAtom);
    data->mAsURIData = true;

    int len = g_strv_length(mDragUris.get());
    for (int i = 0; i < len; i++) {
      data->mUris.AppendElement(UTF8ToNewString(mDragUris.get()[i]));
    }
    return data;
  }

  // MozUrlType (_NETSCAPE_URL) MIME is not registered as URI MIME byt Gtk
  // is it exports it as plain data.  We convert it to "text/x-moz-url"
  // which is UTF16 with line breaks.
  if (mDataFlavor == nsDragSession::sMozUrlTypeAtom) {
    MOZ_ASSERT(mDragData);
    LOGDRAG("ConvertToMozURL(): _NETSCAPE_URL => text/x-moz-url");

    RefPtr<DragData> data = new DragData(nsDragSession::sURLMimeAtom);
    data->mAsURIData = true;
    data->mUris.AppendElement(
        UTF8ToNewString((const char*)mDragData.get(), mDragDataLen));
    return data;
  }

  LOGDRAG("ConvertToMozURL(): failed, wrong MIME %s to convert!",
          GUniquePtr<gchar>(gdk_atom_name(mDataFlavor)).get());
  return nullptr;
}

RefPtr<DragData> DragData::ConvertToFile() const {
  // "text/uri-list" is exported as URI mime type by Gtk, perhaps in UTF8.
  // We convert it to application/x-moz-file.
  if (mDataFlavor != nsDragSession::sTextUriListTypeAtom) {
    return nullptr;
  }
  MOZ_ASSERT(mAsURIData && mDragUris);

  // We can use text/uri-list directly as application/x-moz-file
  return new DragData(nsDragSession::sFileMimeAtom,
                      GUniquePtr<char*>(g_strdupv(mDragUris.get())));
}

static int CopyURI(const nsAString& aSourceURL, nsAString& aTargetURL,
                   int aOffset, bool aRequestNewLine) {
  int32_t uriEnd = aSourceURL.FindChar(u'\n', aOffset);
  if (uriEnd == aOffset) {
    return aOffset + 1;
  }
  if (uriEnd < 0) {
    if (aRequestNewLine) {
      return uriEnd;
    }
    // We may miss newline ending on URL title which is correct
    uriEnd = aSourceURL.Length();
  }

  int32_t newOffset = uriEnd + 1;

  if (aSourceURL[uriEnd - 1] == u'\r') {
    uriEnd--;
  }

  nsDependentSubstring url(aSourceURL, aOffset, uriEnd - aOffset);
  if (aRequestNewLine) {
    url.AppendLiteral("\n");
  }
  aTargetURL.Append(url);

  return newOffset;
}

// It holds the URLs of links followed by their titles,
// separated by a linebreak.
void DragData::ConvertToMozURIList() {
  if (mDataFlavor != nsDragSession::sURLMimeAtom) {
    return;
  }
  mAsURIData = true;

  const nsDependentSubstring uris((char16_t*)mDragData.get(), mDragDataLen / 2);

  LOGDRAG("DragData::ConvertToMozURIList(), data %s",
          NS_ConvertUTF16toUTF8(uris).get());

  int32_t uriBegin = 0;
  do {
    nsAutoString uri;
    // First line contains URL and is terminated by newline
    if ((uriBegin = CopyURI(uris, uri, uriBegin, /* aRequestNewLine */ true)) <
        0) {
      break;
    }
    // Second line is URL title and may be terminated by newline
    if ((uriBegin = CopyURI(uris, uri, uriBegin, /* aRequestNewLine */ false)) <
        0) {
      break;
    }

    LOGDRAG("  URI: %s", NS_ConvertUTF16toUTF8(uri).get());
    mUris.AppendElement(uri);
  } while (uriBegin < (int32_t)uris.Length());

  mDragData = nullptr;
  mDragDataLen = 0;
}

DragData::DragData(GdkAtom aDataFlavor, GUniquePtr<char*> aDragUris)
    : mDataFlavor(aDataFlavor),
      mAsURIData(true),
      mDragUris(std::move(aDragUris)) {}

bool DragData::IsDataValid() const {
  if (mDragData) {
    return mDragData.get() && mDragDataLen;
  } else if (mDragUris) {
    return !!(mDragUris.get()[0]);
  } else {
    return mUris.Length();
  }
}

#ifdef MOZ_LOGGING
void DragData::Print() const {
  if (mDragData) {
    if (IsTextFlavor()) {
      nsCString text((char*)mDragData.get(), mDragDataLen);
      LOGDRAG("DragData() plain data MIME: %s : %s",
              GUniquePtr<gchar>(gdk_atom_name(mDataFlavor)).get(),
              (char*)text.get());
    }
    if (IsURIFlavor()) {
      nsString text((char16_t*)mDragData.get(), mDragDataLen / 2);
      LOGDRAG("DragData() plain data MIME: %s : %s",
              GUniquePtr<gchar>(gdk_atom_name(mDataFlavor)).get(),
              NS_ConvertUTF16toUTF8(text).get());
    }
  } else if (mDragUris) {
    LOGDRAG("DragData() URI MIME %s",
            GUniquePtr<gchar>(gdk_atom_name(mDataFlavor)).get());
    if (MOZ_LOG_TEST(gWidgetDragLog, mozilla::LogLevel::Debug)) {
      int i = 0;
      for (gchar** uri = mDragUris.get(); uri && *uri; uri++, i++) {
        LOGDRAG("%d URI %s", i, *uri);
      }
    }
  } else if (mUris.Length()) {
    LOGDRAG("DragData() URI MIME: %s len %d",
            GUniquePtr<gchar>(gdk_atom_name(mDataFlavor)).get(),
            (int)mUris.Length());
    for (size_t i = 0; i < mUris.Length(); i++) {
      LOGDRAG("%d URI:\n%s", (int)i, NS_ConvertUTF16toUTF8(mUris[i]).get());
    }
  } else {
    LOGDRAG("DragData() MIME %s is missing data",
            GUniquePtr<gchar>(gdk_atom_name(mDataFlavor)).get());
  }
}
#endif

/* static */ int nsDragSession::sEventLoopDepth = 0;

nsDragSession::nsDragSession() {
  LOGDRAGSERVICE("nsDragSession::nsDragSession()");

  // We have to destroy the hidden widget before the event loop stops
  // running.
  nsCOMPtr<nsIObserverService> obsServ =
      mozilla::services::GetObserverService();
  obsServ->AddObserver(this, "quit-application", false);

  // our hidden source widget
  // Using an offscreen window works around bug 983843.
  mHiddenWidget = gtk_offscreen_window_new();
  // make sure that the widget is realized so that
  // we can use it as a drag source.
  gtk_widget_realize(mHiddenWidget);
  // hook up our internal signals so that we can get some feedback
  // from our drag source
  g_signal_connect(mHiddenWidget, "drag_begin",
                   G_CALLBACK(invisibleSourceDragBegin), this);
  g_signal_connect(mHiddenWidget, "drag_data_get",
                   G_CALLBACK(invisibleSourceDragDataGet), this);
  g_signal_connect(mHiddenWidget, "drag_end",
                   G_CALLBACK(invisibleSourceDragEnd), this);
  g_signal_connect(mHiddenWidget, "drag-failed",
                   G_CALLBACK(invisibleSourceDragFailed), this);

  // set up our logging module
  mTempFileTimerID = 0;
#ifdef MOZ_X11
  mActive = widget::GdkIsX11Display();
#endif

  static std::once_flag onceFlag;
  std::call_once(onceFlag, [] {
    sJPEGImageMimeAtom = gdk_atom_intern(kJPEGImageMime, FALSE);
    sJPGImageMimeAtom = gdk_atom_intern(kJPGImageMime, FALSE);
    sPNGImageMimeAtom = gdk_atom_intern(kPNGImageMime, FALSE);
    sGIFImageMimeAtom = gdk_atom_intern(kGIFImageMime, FALSE);
    sCustomTypesMimeAtom = gdk_atom_intern(kCustomTypesMime, FALSE);
    sURLMimeAtom = gdk_atom_intern(kURLMime, FALSE);
    sRTFMimeAtom = gdk_atom_intern(kRTFMime, FALSE);
    sTextMimeAtom = gdk_atom_intern(kTextMime, FALSE);
    sMozUrlTypeAtom = gdk_atom_intern(gMozUrlType, FALSE);
    sMimeListTypeAtom = gdk_atom_intern(gMimeListType, FALSE);
    sTextUriListTypeAtom = gdk_atom_intern(gTextUriListType, FALSE);
    sTextPlainUTF8TypeAtom = gdk_atom_intern(gTextPlainUTF8Type, FALSE);
    sXdndDirectSaveTypeAtom = gdk_atom_intern(gXdndDirectSaveType, FALSE);
    sTabDropTypeAtom = gdk_atom_intern(gTabDropType, FALSE);
    sFileMimeAtom = gdk_atom_intern(kFileMime, FALSE);
    sPortalFileAtom = gdk_atom_intern(gPortalFile, FALSE);
    sPortalFileTransferAtom = gdk_atom_intern(gPortalFileTransfer, FALSE);
    sFilePromiseURLMimeAtom = gdk_atom_intern(kFilePromiseURLMime, FALSE);
    sFilePromiseMimeAtom = gdk_atom_intern(kFilePromiseMime, FALSE);
    sNativeImageMimeAtom = gdk_atom_intern(kNativeImageMime, FALSE);
    sUTF8STRINGMimeAtom = gdk_atom_intern(gUTF8STRINGType, FALSE);
    sSTRINGMimeAtom = gdk_atom_intern(gSTRINGType, FALSE);
  });
}

nsDragSession::~nsDragSession() {
  LOGDRAGSERVICE("nsDragSession::~nsDragSession");
  if (mTaskSource) g_source_remove(mTaskSource);
  MozClearHandleID(mTempFileTimerID, g_source_remove);
  RemoveTempFiles();
  MozClearPointer(mHiddenWidget, gtk_widget_destroy);
}

NS_IMPL_ISUPPORTS_INHERITED(nsDragSession, nsBaseDragSession, nsIObserver)

mozilla::StaticRefPtr<nsDragService> sDragServiceInstance;
/* static */
already_AddRefed<nsDragService> nsDragService::GetInstance() {
  if (gfxPlatform::IsHeadless()) {
    return nullptr;
  }
  if (!sDragServiceInstance) {
    sDragServiceInstance = MakeRefPtr<nsDragService>();
    ClearOnShutdown(&sDragServiceInstance);
  }

  RefPtr<nsDragService> service = sDragServiceInstance.get();
  return service.forget();
}

nsDragService::nsDragService() {
#ifdef MOZ_WAYLAND
  if (StaticPrefs::widget_wayland_native_data_session_AtStartup() &&
      GdkIsWaylandDisplay()) {
    mContext = MakeRefPtr<RetrievalContextWayland>(/* aIsDragContext */ true);
  }
#endif
}

already_AddRefed<nsIDragSession> nsDragService::CreateDragSession() {
#ifdef MOZ_WAYLAND
  if (StaticPrefs::widget_wayland_native_data_session_AtStartup() &&
      widget::GdkIsWaylandDisplay()) {
    return MakeAndAddRef<nsDragSessionWayland>();
  }
#endif
  return MakeAndAddRef<nsDragSessionGtk>();
}

// nsIObserver

NS_IMETHODIMP
nsDragSession::Observe(nsISupports* aSubject, const char* aTopic,
                       const char16_t* aData) {
  if (!nsCRT::strcmp(aTopic, "quit-application")) {
    LOGDRAGSERVICE("nsDragSession::Observe(\"quit-application\")");
    if (mHiddenWidget) {
      gtk_widget_destroy(mHiddenWidget);
      mHiddenWidget = nullptr;
    }
  } else {
    MOZ_ASSERT_UNREACHABLE("unexpected topic");
    return NS_ERROR_UNEXPECTED;
  }

  return NS_OK;
}

// Support for periodic drag events

// http://www.whatwg.org/specs/web-apps/current-work/multipage/dnd.html#drag-and-drop-processing-model
// and the Xdnd protocol both recommend that drag events are sent periodically,
// but GTK does not normally provide this.
//
// Here GTK is periodically stimulated by copies of the most recent mouse
// motion events so as to send drag position messages to the destination when
// appropriate (after it has received a status event from the previous
// message).
//
// (If events were sent only on the destination side then the destination
// would have no message to which it could reply with a drag status.  Without
// sending a drag status to the source, the destination would not be able to
// change its feedback re whether it could accept the drop, and so the
// source's behavior on drop will not be consistent.)

static gboolean DispatchMotionEventCopy(gpointer aData) {
  // Clear the timer id before OnSourceGrabEventAfter is called during event
  // dispatch.
  sMotionEventTimerID = 0;

  GUniquePtr<GdkEvent> event = TakeMotionEvent();
  // If there is no longer a grab on the widget, then the drag is over and
  // there is no need to continue drag motion.
  if (gtk_widget_has_grab(sGrabWidget)) {
    gtk_propagate_event(sGrabWidget, event.get());
  }

  // Cancel this timer;
  // We've already started another if the motion event was dispatched.
  return FALSE;
}

static void OnSourceGrabEventAfter(GtkWidget* widget, GdkEvent* event,
                                   gpointer user_data) {
  // If there is no longer a grab on the widget, then the drag motion is
  // over (though the data may not be fetched yet).
  if (!gtk_widget_has_grab(sGrabWidget)) return;

  if (event->type == GDK_MOTION_NOTIFY) {
    SetMotionEvent(GUniquePtr<GdkEvent>(gdk_event_copy(event)));

    // Update the cursor position.  The last of these recorded gets used for
    // the eDragEnd event.
    nsDragService* dragService = static_cast<nsDragService*>(user_data);
    nsCOMPtr<nsIDragSession> session;
    dragService->GetCurrentSession(nullptr, getter_AddRefs(session));
    if (session) {
      gint scale = mozilla::widget::ScreenHelperGTK::GetGTKMonitorScaleFactor();
      auto p = LayoutDeviceIntPoint::Round(event->motion.x_root * scale,
                                           event->motion.y_root * scale);
      session->SetDragEndPoint(p.x, p.y);
    }
  } else if (sMotionEvent &&
             (event->type == GDK_KEY_PRESS || event->type == GDK_KEY_RELEASE)) {
    // Update modifier state from key events.
    sMotionEvent->motion.state = event->key.state;
  } else {
    return;
  }

  if (sMotionEventTimerID) {
    g_source_remove(sMotionEventTimerID);
  }

  // G_PRIORITY_DEFAULT_IDLE is lower priority than GDK's redraw idle source
  // and lower than GTK's idle source that sends drag position messages after
  // motion-notify signals.
  //
  // http://www.whatwg.org/specs/web-apps/current-work/multipage/dnd.html#drag-and-drop-processing-model
  // recommends an interval of 350ms +/- 200ms.
  sMotionEventTimerID = g_timeout_add_full(
      G_PRIORITY_DEFAULT_IDLE, 350, DispatchMotionEventCopy, nullptr, nullptr);
}

static GtkWindow* GetGtkWindow(dom::Document* aDocument) {
  if (!aDocument) return nullptr;

  PresShell* presShell = aDocument->GetPresShell();
  if (!presShell) {
    return nullptr;
  }

  nsCOMPtr<nsIWidget> widget = presShell->GetRootWidget();
  if (!widget) {
    return nullptr;
  }

  GtkWidget* gtkWidget =
      GTK_WIDGET(widget->GetNativeData(NS_NATIVE_SHELLWIDGET));
  if (!gtkWidget) return nullptr;

  GtkWidget* toplevel = nullptr;
  toplevel = gtk_widget_get_toplevel(gtkWidget);
  if (!GTK_IS_WINDOW(toplevel)) return nullptr;

  return GTK_WINDOW(toplevel);
}

NS_IMETHODIMP
nsDragSession::InvokeDragSession(
    nsIWidget* aWidget, nsINode* aDOMNode, nsIPrincipal* aPrincipal,
    nsIPolicyContainer* aPolicyContainer,
    nsICookieJarSettings* aCookieJarSettings, nsIArray* aArrayTransferables,
    uint32_t aActionType,
    nsContentPolicyType aContentPolicyType = nsIContentPolicy::TYPE_OTHER) {
  LOGDRAGSERVICE("nsDragSession::InvokeDragSession");

  // If the previous source drag has not yet completed, signal handlers need
  // to be removed from sGrabWidget and dragend needs to be dispatched to
  // the source node, but we can't call EndDragSession yet because we don't
  // know whether or not the drag succeeded.
  if (mSourceNode) return NS_ERROR_NOT_AVAILABLE;

  return nsBaseDragSession::InvokeDragSession(
      aWidget, aDOMNode, aPrincipal, aPolicyContainer, aCookieJarSettings,
      aArrayTransferables, aActionType, aContentPolicyType);
}

// nsBaseDragSession
nsresult nsDragSession::InvokeDragSessionImpl(
    nsIWidget* aWidget, nsIArray* aArrayTransferables,
    const Maybe<CSSIntRegion>& aRegion, uint32_t aActionType) {
  // make sure that we have an array of transferables to use
  if (!aArrayTransferables) return NS_ERROR_INVALID_ARG;
  // set our reference to the transferables.  this will also addref
  // the transferables since we're going to hang onto this beyond the
  // length of this call
  mSourceDataItems = aArrayTransferables;

  GdkDevice* device = widget::GdkGetPointer();
  GdkWindow* originGdkWindow = nullptr;
  if (widget::GdkIsWaylandDisplay() || widget::IsXWaylandProtocol()) {
    originGdkWindow =
        gdk_device_get_window_at_position(device, nullptr, nullptr);
    // Workaround for https://gitlab.gnome.org/GNOME/gtk/-/issues/6385
    // Check we have GdkWindow drag source.
    if (!originGdkWindow) {
      NS_WARNING(
          "nsDragSession::InvokeDragSessionImpl(): Missing origin GdkWindow!");
      return NS_ERROR_FAILURE;
    }
  }
#ifdef MOZ_WAYLAND
  if (widget::GdkIsWaylandDisplay() &&
      !gdk_wayland_window_get_wl_surface(originGdkWindow)) {
    NS_WARNING(
        "nsDragSession::InvokeDragSessionImpl(): Missing origin wl_surface!");
    return NS_ERROR_FAILURE;
  }
#endif

  // get the list of items we offer for drags
  GtkTargetList* sourceList = GetSourceList();
  if (!sourceList) {
    return NS_OK;
  }

  // save our action type
  GdkDragAction action = GDK_ACTION_DEFAULT;

  if (aActionType & nsIDragService::DRAGDROP_ACTION_COPY)
    action = (GdkDragAction)(action | GDK_ACTION_COPY);
  if (aActionType & nsIDragService::DRAGDROP_ACTION_MOVE)
    action = (GdkDragAction)(action | GDK_ACTION_MOVE);
  if (aActionType & nsIDragService::DRAGDROP_ACTION_LINK)
    action = (GdkDragAction)(action | GDK_ACTION_LINK);

  GdkEvent* existingEvent = widget::GetLastPointerDownEvent();
  GdkEvent fakeEvent;
  if (!existingEvent) {
    // Create a fake event for the drag so we can pass the time (so to speak).
    // If we don't do this, then, when the timestamp for the pending button
    // release event is used for the ungrab, the ungrab can fail due to the
    // timestamp being _earlier_ than CurrentTime.
    memset(&fakeEvent, 0, sizeof(GdkEvent));
    fakeEvent.type = GDK_BUTTON_PRESS;
    fakeEvent.button.window = gtk_widget_get_window(mHiddenWidget);
    fakeEvent.button.time = nsWindow::GetLastUserInputTime();
    fakeEvent.button.device = device;
  }

  // Put the drag widget in the window group of the source node so that the
  // gtk_grab_add during gtk_drag_begin is effective.
  // gtk_window_get_group(nullptr) returns the default window group.
  GtkWindowGroup* window_group =
      gtk_window_get_group(GetGtkWindow(mSourceDocument));
  gtk_window_group_add_window(window_group, GTK_WINDOW(mHiddenWidget));

  LOGDRAGSERVICE("nsDragSession::InvokeDragSessionImpl() originGdkWindow [%p]",
                 originGdkWindow);

  // start our drag.
  GdkDragContext* context = gtk_drag_begin_with_coordinates(
      mHiddenWidget, sourceList, action, 1,
      existingEvent ? existingEvent : &fakeEvent, -1, -1);

  if (originGdkWindow) {
    mSourceWindow = nsWindow::GetWindow(originGdkWindow);
    if (mSourceWindow) {
      mSourceWindow->SetDragSource(context);
    }
  }

  LOGDRAGSERVICE("  GdkDragContext [%p] nsWindow [%p]", context,
                 mSourceWindow.get());

  nsresult rv;
  if (context) {
    // GTK uses another hidden window for receiving mouse events.
    sGrabWidget = gtk_window_group_get_current_grab(window_group);
    if (sGrabWidget) {
      g_object_ref(sGrabWidget);
      // Only motion and key events are required but connect to
      // "event-after" as this is never blocked by other handlers.
      g_signal_connect(sGrabWidget, "event-after",
                       G_CALLBACK(OnSourceGrabEventAfter), this);
    }
    // We don't have a drag end point yet.
    mEndDragPoint = LayoutDeviceIntPoint(-1, -1);
    rv = NS_OK;
  } else {
    rv = NS_ERROR_FAILURE;
  }

  gtk_target_list_unref(sourceList);

  return rv;
}

nsIDragSession* nsDragService::StartDragSession(nsISupports* aWidgetProvider) {
  return nsBaseDragService::StartDragSession(aWidgetProvider);
}

bool nsDragSession::RemoveTempFiles() {
  LOGDRAGSERVICE("nsDragSession::RemoveTempFiles");

  // We can not delete the temporary files immediately after the
  // drag has finished, because the target application might have not
  // copied the temporary file yet. The Qt toolkit does not provide a
  // way to mark a drop as finished in an asynchronous way, so most
  // Qt based applications do send the dnd_finished signal before they
  // have actually accessed the data from the temporary file.
  // (https://bugreports.qt.io/browse/QTBUG-5441)
  //
  // To work also with these applications we collect all temporary
  // files in mTemporaryFiles array and remove them here in the timer event.
  auto files = std::move(mTemporaryFiles);
  for (nsIFile* file : files) {
#ifdef MOZ_LOGGING
    if (MOZ_LOG_TEST(gWidgetDragLog, LogLevel::Debug)) {
      nsAutoCString path;
      if (NS_SUCCEEDED(file->GetNativePath(path))) {
        LOGDRAGSERVICE("  removing %s", path.get());
      }
    }
#endif
    file->Remove(/* recursive = */ true);
  }
  MOZ_ASSERT(mTemporaryFiles.IsEmpty());
  mTempFileTimerID = 0;
  // Return false to remove the timer added by g_timeout_add_full().
  return false;
}

/* static */
gboolean nsDragSession::TaskRemoveTempFiles(gpointer data) {
  // data is a manually addrefed drag session from EndDragSession.
  // We manually deref it here.
  RefPtr<nsDragSession> session = static_cast<nsDragSession*>(data);
  session.get()->Release();
  return session->RemoveTempFiles();
}

nsresult nsDragSession::EndDragSessionImpl(bool aDoneDrag,
                                           uint32_t aKeyModifiers) {
  LOGDRAGSERVICE("nsDragSession::EndDragSessionImpl() %d", aDoneDrag);

  if (sGrabWidget) {
    g_signal_handlers_disconnect_by_func(
        sGrabWidget, FuncToGpointer(OnSourceGrabEventAfter), this);
    g_object_unref(sGrabWidget);
    sGrabWidget = nullptr;

    if (sMotionEventTimerID) {
      g_source_remove(sMotionEventTimerID);
      sMotionEventTimerID = 0;
    }
    if (sMotionEvent) {
      TakeMotionEvent();
    }
  }

  // unset our drag action
  SetDragAction(nsIDragService::DRAGDROP_ACTION_NONE);

  // start timer to remove temporary files
  if (mTemporaryFiles.Count() > 0 && !mTempFileTimerID) {
    LOGDRAGSERVICE("  queue removing of temporary files");
    // |this| won't be used after nsDragSession delete because the timer is
    // removed in the nsDragSession destructor.
    // Manually addref this and pass to TaskRemoveTempFiles where it is
    // derefed.
    AddRef();
    mTempFileTimerID =
        g_timeout_add(NS_DND_TMP_CLEANUP_TIMEOUT, TaskRemoveTempFiles, this);
    mTempFileUrls.Clear();
  }

  // We're done with the drag context.
  if (mSourceWindow) {
    mSourceWindow->SetDragSource(nullptr);
    mSourceWindow = nullptr;
  }
  mCachedDragContextID = 0;

  nsCOMPtr<nsIObserverService> obsServ =
      mozilla::services::GetObserverService();
  obsServ->RemoveObserver(this, "quit-application");

  if (mHiddenWidget) {
    gtk_widget_destroy(mHiddenWidget);
    mHiddenWidget = nullptr;
  }
  mNextScheduledTask = nullptr;
  mRecentTask->Reset();

  // Clear backend (X11/Wayland)
  EndDragSessionImplBackend();

  return nsBaseDragSession::EndDragSessionImpl(aDoneDrag, aKeyModifiers);
}

// nsIDragSession
NS_IMETHODIMP
nsDragSession::SetCanDrop(bool aCanDrop) {
  LOGDRAGSERVICE("nsDragSession::SetCanDrop %d", aCanDrop);
  mCanDrop = aCanDrop;
  return NS_OK;
}

NS_IMETHODIMP
nsDragSession::GetCanDrop(bool* aCanDrop) {
  LOGDRAGSERVICE("nsDragSession::GetCanDrop");
  *aCanDrop = mCanDrop;
  return NS_OK;
}

// Spins event loop, called from JS.
// Can lead to another round of drag_motion events.
NS_IMETHODIMP
nsDragSession::GetNumDropItems(uint32_t* aNumItems) {
  LOGDRAGSERVICE("nsDragSession::GetNumDropItems");

  GtkWidget* widget =
      mRecentTask->mWindow ? mRecentTask->mWindow->GetGtkWidget() : nullptr;
  if (!widget) {
    LOGDRAGSERVICE(
        "*** warning: GetNumDropItems \
               called without a valid target widget!\n");
    *aNumItems = 0;
    return NS_OK;
  }

  if (IsTargetContextList()) {
    if (!mSourceDataItems) {
      *aNumItems = 0;
      return NS_OK;
    }
    mSourceDataItems->GetLength(aNumItems);
    LOGDRAGSERVICE("GetNumDropItems(): TargetContextList items %d", *aNumItems);
    return NS_OK;
  }

  // Put text/uri-list first, text/x-moz-url tends to be poorly supported
  // by third party apps, we got only one file instead of file list
  // for instance (Bug 1908196).
  //
  // We're getting the data to only get number of items here,
  // actual data will be received at nsDragSession::GetData().
  const GdkAtom fileListFlavors[] = {sTextUriListTypeAtom,  // text/uri-list
                                     sPortalFileAtom, sPortalFileTransferAtom,
                                     sURLMimeAtom};  // text/x-moz-url

  for (auto fileFlavour : fileListFlavors) {
    RefPtr<DragData> data = GetDragData(fileFlavour);
    if (data) {
      *aNumItems = data->GetURIsNum();
      LOGDRAGSERVICE("GetNumDropItems(): Found MIME %s items %d",
                     GUniquePtr<gchar>(gdk_atom_name(fileFlavour)).get(),
                     *aNumItems);
      return NS_OK;
    }
  }

  // We're missing any file list MIME, return only one item.
  *aNumItems = 1;
  LOGDRAGSERVICE("GetNumDropItems(): no list available");
  return NS_OK;
}

// Spins event loop, called from JS.
// Can lead to another round of drag_motion events.
NS_IMETHODIMP
nsDragSession::GetData(nsITransferable* aTransferable, uint32_t aItemIndex) {
  LOGDRAGSERVICE("nsDragSession::GetData(), index %d", aItemIndex);

  // make sure that we have a transferable
  if (!aTransferable) {
    return NS_ERROR_INVALID_ARG;
  }

  GtkWidget* widget =
      mRecentTask->mWindow ? mRecentTask->mWindow->GetGtkWidget() : nullptr;
  if (!widget) {
    LOGDRAGSERVICE(
        "*** failed: GetData called without a valid target widget!\n");
    return NS_ERROR_FAILURE;
  }

  // get flavor list that includes all acceptable flavors (including
  // ones obtained through conversion).
  nsTArray<nsCString> flavors;
  nsresult rv = aTransferable->FlavorsTransferableCanImport(flavors);
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  failed to get flavors, quit.");
    return rv;
  }

  // check to see if this is an internal list
  if (IsTargetContextList()) {
    LOGDRAGSERVICE("  Process as a list...");
    // find a matching flavor
    for (uint32_t i = 0; i < flavors.Length(); ++i) {
      nsCString& flavorStr = flavors[i];
      LOGDRAGSERVICE("  [%d] flavor is %s\n", i, flavorStr.get());
      // get the item with the right index
      nsCOMPtr<nsITransferable> item =
          do_QueryElementAt(mSourceDataItems, aItemIndex);
      if (!item) continue;

      nsCOMPtr<nsISupports> data;
      LOGDRAGSERVICE("  trying to get transfer data for %s\n", flavorStr.get());
      rv = item->GetTransferData(flavorStr.get(), getter_AddRefs(data));
      if (NS_FAILED(rv)) {
        LOGDRAGSERVICE("  failed.\n");
        continue;
      }
      rv = aTransferable->SetTransferData(flavorStr.get(), data);
      if (NS_FAILED(rv)) {
        LOGDRAGSERVICE("  fail to set transfer data into transferable!\n");
        continue;
      }
      LOGDRAGSERVICE("  succeeded\n");
      // ok, we got the data
      return NS_OK;
    }
    // if we got this far, we failed
    LOGDRAGSERVICE("  failed to match flavors\n");
    return NS_ERROR_FAILURE;
  }

  // Now walk down the list of flavors. When we find one that is
  // actually present, copy out the data into the transferable in that
  // format. SetTransferData() implicitly handles conversions.
  for (uint32_t i = 0; i < flavors.Length(); ++i) {
    nsCString& flavorStr = flavors[i];

    GdkAtom requestedFlavor = gdk_atom_intern(flavorStr.get(), FALSE);
    if (!requestedFlavor) {
      continue;
    }

    LOGDRAGSERVICE("  we're getting data %s\n", flavorStr.get());

    RefPtr<DragData> dragData;

    // Let's do conversions first. We may be asked for some kind of MIME
    // type data but we rather try to get something different and
    // convert to desider MIME type.

    // We're asked to get text data. Try to get UTF-8 variant first.
    if (requestedFlavor == sTextMimeAtom) {
      dragData = GetDragData(sTextPlainUTF8TypeAtom);
    }

    // Try portals first since text/uri-list URIs in sandboxed environments
    // (Flatpak/Snap) may point to inaccessible file paths.
    if (requestedFlavor == sURLMimeAtom || requestedFlavor == sFileMimeAtom) {
      LOGDRAGSERVICE("  try portals first\n");
      dragData = GetDragData(sPortalFileAtom);
      if (!dragData) {
        dragData = GetDragData(sPortalFileTransferAtom);
      }
    }

    // We are looking for text/x-moz-url. That format may be poorly supported,
    // try first with text/uri-list, and then _NETSCAPE_URL
    if (!dragData && requestedFlavor == sURLMimeAtom) {
      LOGDRAGSERVICE("  conversion %s => %s", gTextUriListType, kURLMime);
      dragData = GetDragData(sTextUriListTypeAtom);
      if (dragData) {
        dragData = dragData->ConvertToMozURL();
        mCachedDragData.InsertOrUpdate(dragData->GetFlavor(), dragData);
      }
      if (!dragData) {
        LOGDRAGSERVICE("  conversion %s => %s", gMozUrlType, kURLMime);
        dragData = GetDragData(sMozUrlTypeAtom);
        if (dragData) {
          dragData = dragData->ConvertToMozURL();
          if (dragData) {
            mCachedDragData.InsertOrUpdate(dragData->GetFlavor(), dragData);
          }
        }
      }
    }

    // Try to get requested MIME directly
    if (!dragData) {
      dragData = GetDragData(requestedFlavor);
    }

    // We're asked to get file mime type but we failed.
    // Try text/uri-list conversion.
    if (!dragData && requestedFlavor == sFileMimeAtom) {
      LOGDRAGSERVICE(
          "  file not found, proceed with conversion %s => %s flavor\n",
          gTextUriListType, kFileMime);
      // Conversion text/uri-list => application/x-moz-file
      dragData = GetDragData(sTextUriListTypeAtom);
      if (dragData) {
        dragData = dragData->ConvertToFile();
        if (dragData) {
          mCachedDragData.InsertOrUpdate(dragData->GetFlavor(), dragData);
        }
      }
    }

    if (dragData && dragData->Export(aTransferable, aItemIndex)) {
      // We usually want to also get URL for images so continue
      if (dragData->IsImageFlavor()) {
        continue;
      }
      return NS_OK;
    }
  }

  return NS_ERROR_FAILURE;
}

NS_IMETHODIMP
nsDragSession::IsDataFlavorSupported(const char* aDataFlavor, bool* _retval) {
  LOGDRAGSERVICE("nsDragSession::IsDataFlavorSupported() %s", aDataFlavor);
  if (!_retval) {
    return NS_ERROR_INVALID_ARG;
  }

  // set this to no by default
  *_retval = false;

  // check to make sure that we have a drag object set, here
  GtkWidget* widget =
      mRecentTask->mWindow ? mRecentTask->mWindow->GetGtkWidget() : nullptr;
  if (!widget) {
    LOGDRAGSERVICE(
        "*** warning: IsDataFlavorSupported called without a valid target "
        "widget!\n");
    return NS_OK;
  }

  // check to see if the target context is a list.
  // if it is, just look in the internal data since we are the source
  // for it.
  if (IsTargetContextList()) {
    LOGDRAGSERVICE("  It's a list");
    uint32_t numDragItems = 0;
    // if we don't have mDataItems we didn't start this drag so it's
    // an external client trying to fool us.
    if (!mSourceDataItems) {
      LOGDRAGSERVICE("  quit");
      return NS_OK;
    }
    mSourceDataItems->GetLength(&numDragItems);
    LOGDRAGSERVICE("  drag items %d", numDragItems);
    for (uint32_t itemIndex = 0; itemIndex < numDragItems; ++itemIndex) {
      nsCOMPtr<nsITransferable> currItem =
          do_QueryElementAt(mSourceDataItems, itemIndex);
      if (currItem) {
        nsTArray<nsCString> flavors;
        currItem->FlavorsTransferableCanExport(flavors);
        for (uint32_t i = 0; i < flavors.Length(); ++i) {
          LOGDRAGSERVICE("  checking %s against %s\n", flavors[i].get(),
                         aDataFlavor);
          if (flavors[i].Equals(aDataFlavor)) {
            LOGDRAGSERVICE("  found.\n");
            *_retval = true;
          }
        }
      }
    }
    return NS_OK;
  }

  GdkAtom requestedFlavor = gdk_atom_intern(aDataFlavor, FALSE);
  if (IsDragFlavorAvailable(requestedFlavor)) {
    LOGDRAGSERVICE("  %s is supported", aDataFlavor);
    *_retval = true;
    return NS_OK;
  }

  // GetData can convert text/plain;charset=utf-8 to text/plain, so report it
  // as supported here too.
  if (requestedFlavor == sTextMimeAtom &&
      IsDragFlavorAvailable(sTextPlainUTF8TypeAtom)) {
    LOGDRAGSERVICE("  %s supported with conversion from %s", aDataFlavor,
                   gTextPlainUTF8Type);
    *_retval = true;
    return NS_OK;
  }

  // Check for file/url conversion from uri list
  if ((requestedFlavor == sURLMimeAtom || requestedFlavor == sFileMimeAtom) &&
      IsDragFlavorAvailable(sTextUriListTypeAtom)) {
    LOGDRAGSERVICE("  %s supported with conversion from %s", aDataFlavor,
                   gTextUriListType);
    *_retval = true;
    return NS_OK;
  }

  // check for automatic _NETSCAPE_URL -> text/x-moz-url mapping
  if (requestedFlavor == sURLMimeAtom &&
      IsDragFlavorAvailable(sMozUrlTypeAtom)) {
    LOGDRAGSERVICE("  %s supported with conversion from %s", aDataFlavor,
                   gMozUrlType);
    *_retval = true;
    return NS_OK;
  }

  // If we're asked for kURLMime/kFileMime we can get it from PortalFile
  // or PortalFileTransfer flavors.
  if ((requestedFlavor == sURLMimeAtom || requestedFlavor == sFileMimeAtom) &&
      (IsDragFlavorAvailable(sPortalFileAtom) ||
       IsDragFlavorAvailable(sPortalFileTransferAtom))) {
    LOGDRAGSERVICE("  %s supported with conversion from %s/%s", aDataFlavor,
                   gPortalFile, gPortalFileTransfer);
    *_retval = true;
    return NS_OK;
  }

  LOGDRAGSERVICE("  %s is not supported", aDataFlavor);
  return NS_OK;
}

void nsDragSession::SetCachedDragContext(uintptr_t aDragContextID) {
  LOGDRAGSERVICE("nsDragSession::SetCachedDragContext(): [drag %p / cached %p]",
                 (void*)aDragContextID, (void*)mCachedDragContextID);
  // Clear cache data if we're going to D&D with different drag context.
  if (aDragContextID && aDragContextID != mCachedDragContextID) {
    LOGDRAGSERVICE("  cache clear, new context %p", (void*)aDragContextID);
    mCachedDragContextID = aDragContextID;
    mCachedDragData.Clear();
    mCachedDragFlavors.Clear();
  }
}

// Spins event loop, called from eDragTaskMotion handler by
// DispatchMotionEvents().
// Can lead to another round of drag_motion events.
RefPtr<DragData> nsDragSession::GetDragData(GdkAtom aRequestedFlavor) {
  LOGDRAGSERVICE("nsDragSession::GetDragData() requested '%s'\n",
                 GUniquePtr<gchar>(gdk_atom_name(aRequestedFlavor)).get());

  // Return early when requested MIME is not offered by D&D.
  if (!IsDragFlavorAvailable(aRequestedFlavor)) {
    LOGDRAGSERVICE("  %s is missing",
                   GUniquePtr<gchar>(gdk_atom_name(aRequestedFlavor)).get());
    return nullptr;
  }

  {
    auto data = mCachedDragData.MaybeGet(GDK_ATOM_TO_POINTER(aRequestedFlavor));
    if (data) {
      LOGDRAGSERVICE("  MIME %s found in cache, %s",
                     GUniquePtr<gchar>(gdk_atom_name(aRequestedFlavor)).get(),
                     *data ? "got correctly" : "failed to get");
      return *data;
    }
  }

  if (!GetDragDataImpl(aRequestedFlavor)) {
    LOGDRAGSERVICE("  %s failed to get from system",
                   GUniquePtr<gchar>(gdk_atom_name(aRequestedFlavor)).get());
    return nullptr;
  }

  RefPtr<DragData> data =
      mCachedDragData.Get(GDK_ATOM_TO_POINTER(aRequestedFlavor));
  if (!data) {
    NS_WARNING(nsPrintfCString(
                   "nsDragSession::GetDragData() %s failed to get from cache",
                   GUniquePtr<gchar>(gdk_atom_name(aRequestedFlavor)).get())
                   .get());
    return nullptr;
  }

  LOGDRAGSERVICE("  %s received",
                 GUniquePtr<gchar>(gdk_atom_name(aRequestedFlavor)).get());
  return data;
}

static void TargetArrayAddTarget(nsTArray<GtkTargetEntry*>& aTargetArray,
                                 const char* aTarget) {
  GtkTargetEntry* target = (GtkTargetEntry*)g_malloc(sizeof(GtkTargetEntry));
  target->target = g_strdup(aTarget);
  target->flags = 0;
  aTargetArray.AppendElement(target);
  LOGDRAGSERVICESTATIC("adding target %s\n", aTarget);
}

static bool CanExportAsURLTarget(const char16_t* aURLData, uint32_t aURLLen) {
  for (const nsLiteralString& disallowed : kDisallowedExportedSchemes) {
    auto len = disallowed.AsString().Length();
    if (len < aURLLen) {
      if (!memcmp(disallowed.get(), aURLData,
                  /* len is char16_t char count */ len * 2)) {
        LOGDRAGSERVICESTATIC("rejected URL scheme %s\n",
                             NS_ConvertUTF16toUTF8(disallowed).get());
        return false;
      }
    }
  }
  return true;
}

GtkTargetList* nsDragSession::GetSourceList(void) {
  if (!mSourceDataItems) {
    return nullptr;
  }

  nsTArray<GtkTargetEntry*> targetArray;
  GtkTargetEntry* targets;
  GtkTargetList* targetList = nullptr;
  uint32_t targetCount = 0;
  unsigned int numDragItems = 0;

  mSourceDataItems->GetLength(&numDragItems);
  LOGDRAGSERVICE("  numDragItems = %d", numDragItems);

  // Check to see if we're dragging > 1 item.
  if (numDragItems > 1) {
    // as the Xdnd protocol only supports a single item (or is it just
    // gtk's implementation?), we don't advertise all flavours listed
    // in the nsITransferable.

    // the application/x-moz-internal-item-list format, which preserves
    // all information for drags within the same mozilla instance.
    TargetArrayAddTarget(targetArray, gMimeListType);

    // check what flavours are supported so we can decide what other
    // targets to advertise.
    nsCOMPtr<nsITransferable> currItem = do_QueryElementAt(mSourceDataItems, 0);

    if (currItem) {
      nsTArray<nsCString> flavors;
      currItem->FlavorsTransferableCanExport(flavors);
      for (uint32_t i = 0; i < flavors.Length(); ++i) {
        // check if text/x-moz-url is supported.
        // If so, advertise
        // text/uri-list.
        if (flavors[i].EqualsLiteral(kURLMime)) {
          TargetArrayAddTarget(targetArray, gTextUriListType);
          break;
        }
      }
    }  // if item is a transferable
  } else if (numDragItems == 1) {
    nsCOMPtr<nsITransferable> currItem = do_QueryElementAt(mSourceDataItems, 0);
    if (currItem) {
      nsTArray<nsCString> flavors;
      currItem->FlavorsTransferableCanExport(flavors);
      for (uint32_t i = 0; i < flavors.Length(); ++i) {
        nsCString& flavorStr = flavors[i];
        GdkAtom requestedFlavor = gdk_atom_intern(flavorStr.get(), FALSE);
        if (!requestedFlavor) {
          continue;
        }

        TargetArrayAddTarget(targetArray, flavorStr.get());

        // If there is a file, add the text/uri-list type.
        if (requestedFlavor == sFileMimeAtom) {
          TargetArrayAddTarget(targetArray, gTextUriListType);
        }
        // Check to see if this is text/plain.
        else if (requestedFlavor == sTextMimeAtom) {
          TargetArrayAddTarget(targetArray, gTextPlainUTF8Type);
          TargetArrayAddTarget(targetArray, gUTF8STRINGType);
          TargetArrayAddTarget(targetArray, gSTRINGType);
        }
        // Check to see if this is the x-moz-url type.
        // If it is, add _NETSCAPE_URL
        // this is a type used by everybody.
        else if (requestedFlavor == sURLMimeAtom) {
          nsCOMPtr<nsISupports> data;
          if (NS_SUCCEEDED(currItem->GetTransferData(flavorStr.get(),
                                                     getter_AddRefs(data)))) {
            void* tmpData = nullptr;
            uint32_t tmpDataLen = 0;
            nsPrimitiveHelpers::CreateDataFromPrimitive(
                nsDependentCString(flavorStr.get()), data, &tmpData,
                &tmpDataLen);
            if (tmpData) {
              if (CanExportAsURLTarget(reinterpret_cast<char16_t*>(tmpData),
                                       tmpDataLen / 2)) {
                TargetArrayAddTarget(targetArray, gMozUrlType);
              }
              free(tmpData);
            }
          }
        }
        // check if application/x-moz-file-promise url is supported.
        // If so, advertise text/uri-list.
        else if (requestedFlavor == sFilePromiseURLMimeAtom) {
          TargetArrayAddTarget(targetArray, gTextUriListType);
        }
        // XdndDirectSave, use on X.org only.
        else if (widget::GdkIsX11Display() && !widget::IsXWaylandProtocol() &&
                 requestedFlavor == sFilePromiseMimeAtom) {
          TargetArrayAddTarget(targetArray, gXdndDirectSaveType);
        }
        // kNativeImageMime
        else if (requestedFlavor == sNativeImageMimeAtom) {
          TargetArrayAddTarget(targetArray, kPNGImageMime);
          TargetArrayAddTarget(targetArray, kJPEGImageMime);
          TargetArrayAddTarget(targetArray, kJPGImageMime);
          TargetArrayAddTarget(targetArray, kGIFImageMime);
        }
      }
    }
  }

  // get all the elements that we created.
  targetCount = targetArray.Length();
  if (targetCount) {
    // allocate space to create the list of valid targets
    targets = (GtkTargetEntry*)g_malloc(sizeof(GtkTargetEntry) * targetCount);
    uint32_t targetIndex;
    for (targetIndex = 0; targetIndex < targetCount; ++targetIndex) {
      GtkTargetEntry* disEntry = targetArray.ElementAt(targetIndex);
      // this is a string reference but it will be freed later.
      targets[targetIndex].target = disEntry->target;
      targets[targetIndex].flags = disEntry->flags;
      targets[targetIndex].info = 0;
    }
    targetList = gtk_target_list_new(targets, targetCount);
    // clean up the target list
    for (uint32_t cleanIndex = 0; cleanIndex < targetCount; ++cleanIndex) {
      GtkTargetEntry* thisTarget = targetArray.ElementAt(cleanIndex);
      g_free(thisTarget->target);
      g_free(thisTarget);
    }
    g_free(targets);
  } else {
    // We need to create a dummy target list to be able initialize dnd.
    targetList = gtk_target_list_new(nullptr, 0);
  }
  return targetList;
}

void nsDragSession::EndDragSessionMainThread() {
  EndDragSession(true, nsDragSession::GetCurrentModifiers());
}

void nsDragSession::SourceEndDragSession(GdkDragContext* aContext,
                                         gint aResult) {
  LOGDRAGSERVICE("SourceEndDragSession(%p) result %s\n", aContext,
                 kGtkDragResults[aResult]);

  // this just releases the list of data items that we provide
  mSourceDataItems = nullptr;

  // Remove this property, if it exists, to satisfy the Direct Save Protocol.
  GdkAtom property = sXdndDirectSaveTypeAtom;
  gdk_property_delete(gdk_drag_context_get_source_window(aContext), property);

  if (!mDoingDrag || mDragTaskSourceFinished)
    // EndDragSession() was already called on drop
    // or SourceEndDragSession on drag-failed
    return;

  if (mEndDragPoint.x < 0) {
    // We don't have a drag end point, so guess
    gint x, y;
    GdkDisplay* display = gdk_display_get_default();
    GdkScreen* screen = gdk_display_get_default_screen(display);
    GtkWindow* window = GetGtkWindow(mSourceDocument);
    GdkWindow* gdkWindow = window ? gtk_widget_get_window(GTK_WIDGET(window))
                                  : gdk_screen_get_root_window(screen);
    if (!gdkWindow) {
      return;
    }
    gdk_window_get_device_position(
        gdkWindow, gdk_drag_context_get_device(aContext), &x, &y, nullptr);
    gint scale = gdk_window_get_scale_factor(gdkWindow);
    SetDragEndPoint(x * scale, y * scale);
    LOGDRAGSERVICE("  guess drag end point %d %d\n", x * scale, y * scale);
  }

  // Either the drag was aborted or the drop occurred outside the app.
  // The dropEffect of mDataTransfer is not updated for motion outside the
  // app, but is needed for the dragend event, so set it now.

  uint32_t dropEffect;

  if (aResult == GTK_DRAG_RESULT_SUCCESS) {
    LOGDRAGSERVICE("  drop is accepted");
    // With GTK+ versions 2.10.x and prior the drag may have been
    // cancelled (but no drag-failed signal would have been sent).
    // aContext->dest_window will be non-nullptr only if the drop was
    // sent.
    GdkDragAction action = gdk_drag_context_get_dest_window(aContext)
                               ? gdk_drag_context_get_actions(aContext)
                               : (GdkDragAction)0;

    // Only one bit of action should be set, but, just in case someone
    // does something funny, erring away from MOVE, and not recording
    // unusual action combinations as NONE.
    if (!action) {
      LOGDRAGSERVICE("  drop action is none");
      dropEffect = nsIDragService::DRAGDROP_ACTION_NONE;
    } else if (action & GDK_ACTION_COPY) {
      LOGDRAGSERVICE("  drop action is copy");
      dropEffect = nsIDragService::DRAGDROP_ACTION_COPY;
    } else if (action & GDK_ACTION_LINK) {
      LOGDRAGSERVICE("  drop action is link");
      dropEffect = nsIDragService::DRAGDROP_ACTION_LINK;
    } else if (action & GDK_ACTION_MOVE) {
      LOGDRAGSERVICE("  drop action is move");
      dropEffect = nsIDragService::DRAGDROP_ACTION_MOVE;
    } else {
      LOGDRAGSERVICE("  drop action is copy");
      dropEffect = nsIDragService::DRAGDROP_ACTION_COPY;
    }
  } else {
    LOGDRAGSERVICE("  drop action is none");
    dropEffect = nsIDragService::DRAGDROP_ACTION_NONE;
    if (aResult != GTK_DRAG_RESULT_NO_TARGET) {
      LOGDRAGSERVICE("  drop is user chancelled\n");
      mUserCancelled = true;
    }
  }

  if (mDataTransfer) {
    mDataTransfer->SetDropEffectInt(dropEffect);
  }

  // If aTask is eDragTaskSourceEnd, then it will replace even a scheduled
  // drop event (which could happen if the drop event has not been processed
  // within the allowed time).  Otherwise, if we haven't yet run a scheduled
  // drop or end task, just say that we are not ready to receive another
  // drop.
  mDragTaskSourceFinished = true;
  NS_DispatchToMainThread(
      NewRunnableMethod("nsDragSession::EndDragSession", this,
                        &nsDragSession::EndDragSessionMainThread));
}

static nsresult GetDownloadDetails(nsITransferable* aTransferable,
                                   nsIURI** aSourceURI, nsAString& aFilename) {
  *aSourceURI = nullptr;
  MOZ_ASSERT(aTransferable != nullptr, "aTransferable must not be null");

  // get the URI from the kFilePromiseURLMime flavor
  nsCOMPtr<nsISupports> urlPrimitive;
  nsresult rv = aTransferable->GetTransferData(kFilePromiseURLMime,
                                               getter_AddRefs(urlPrimitive));
  if (NS_FAILED(rv)) {
    return NS_ERROR_FAILURE;
  }
  nsCOMPtr<nsISupportsString> srcUrlPrimitive = do_QueryInterface(urlPrimitive);
  if (!srcUrlPrimitive) {
    return NS_ERROR_FAILURE;
  }

  nsAutoString srcUri;
  srcUrlPrimitive->GetData(srcUri);
  if (srcUri.IsEmpty()) {
    return NS_ERROR_FAILURE;
  }
  nsCOMPtr<nsIURI> sourceURI;
  NS_NewURI(getter_AddRefs(sourceURI), srcUri);

  nsAutoString srcFileName;
  nsCOMPtr<nsISupports> fileNamePrimitive;
  rv = aTransferable->GetTransferData(kFilePromiseDestFilename,
                                      getter_AddRefs(fileNamePrimitive));
  if (NS_FAILED(rv)) {
    return NS_ERROR_FAILURE;
  }
  nsCOMPtr<nsISupportsString> srcFileNamePrimitive =
      do_QueryInterface(fileNamePrimitive);
  if (srcFileNamePrimitive) {
    srcFileNamePrimitive->GetData(srcFileName);
  } else {
    nsCOMPtr<nsIURL> sourceURL = do_QueryInterface(sourceURI);
    if (!sourceURL) {
      return NS_ERROR_FAILURE;
    }
    nsAutoCString urlFileName;
    sourceURL->GetFileName(urlFileName);
    NS_UnescapeURL(urlFileName);
    CopyUTF8toUTF16(urlFileName, srcFileName);
  }
  if (srcFileName.IsEmpty()) {
    return NS_ERROR_FAILURE;
  }

  sourceURI.swap(*aSourceURI);
  aFilename = std::move(srcFileName);
  return NS_OK;
}

// See nsContentAreaDragDropDataProvider::GetFlavorData() for reference.
nsresult nsDragSession::CreateTempFile(nsITransferable* aItem,
                                       nsACString& aURI) {
  LOGDRAGSERVICE("nsDragSession::CreateTempFile()");

  nsCOMPtr<nsIFile> tmpDir;
  nsresult rv = NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(tmpDir));
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  Failed to get temp directory\n");
    return rv;
  }

  nsCOMPtr<nsIInputStream> inputStream;
  nsCOMPtr<nsIChannel> channel;

  // extract the file name and source uri of the promise-file data
  nsAutoString wideFileName;
  nsCOMPtr<nsIURI> sourceURI;
  rv = GetDownloadDetails(aItem, getter_AddRefs(sourceURI), wideFileName);
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE(
        "  Failed to extract file name and source uri from download url");
    return rv;
  }

  // Check if the file is already stored at /tmp.
  // It happens when drop destination is changed and SourceDataGet() is caled
  // more than once.
  nsAutoCString fileName;
  CopyUTF16toUTF8(wideFileName, fileName);
  auto fileLen = fileName.Length();
  for (const auto& url : mTempFileUrls) {
    auto URLLen = url.Length();
    if (URLLen > fileLen &&
        fileName.Equals(nsDependentCString(url, URLLen - fileLen))) {
      aURI = url;
      LOGDRAGSERVICE("  recycle file %s", PromiseFlatCString(aURI).get());
      return NS_OK;
    }
  }

  // create and open channel for source uri
  nsCOMPtr<nsIPrincipal> principal = aItem->GetDataPrincipal();
  nsContentPolicyType contentPolicyType = aItem->GetContentPolicyType();
  nsCOMPtr<nsICookieJarSettings> cookieJarSettings =
      aItem->GetCookieJarSettings();
  rv = NS_NewChannel(getter_AddRefs(channel), sourceURI, principal,
                     nsILoadInfo::SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
                     contentPolicyType, cookieJarSettings);
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  Failed to create new channel for source uri");
    return rv;
  }

  rv = channel->Open(getter_AddRefs(inputStream));
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  Failed to open channel for source uri");
    return rv;
  }

  // build the file:///tmp/dnd_file URL
  tmpDir->Append(NS_LITERAL_STRING_FROM_CSTRING("dnd_file"));
  rv = tmpDir->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700);
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  Failed create tmp dir");
    return rv;
  }

  // store a copy of that temporary directory so we can
  // clean them up when nsDragSession is destructed
  nsCOMPtr<nsIFile> tempFile;
  tmpDir->Clone(getter_AddRefs(tempFile));
  mTemporaryFiles.AppendObject(tempFile);
  MozClearHandleID(mTempFileTimerID, g_source_remove);

  // extend file:///tmp/dnd_file/<filename> URL
  tmpDir->Append(wideFileName);

  nsCOMPtr<nsIOutputStream> outputStream;
  rv = NS_NewLocalFileOutputStream(getter_AddRefs(outputStream), tmpDir);
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  Failed to open output stream for temporary file");
    return rv;
  }

  char buffer[8192];
  uint32_t readCount = 0;
  uint32_t writeCount = 0;
  while (true) {
    rv = inputStream->Read(buffer, sizeof(buffer), &readCount);
    if (NS_FAILED(rv)) {
      LOGDRAGSERVICE("  Failed to read data from source uri");
      return rv;
    }

    if (readCount == 0) break;

    rv = outputStream->Write(buffer, readCount, &writeCount);
    if (NS_FAILED(rv)) {
      LOGDRAGSERVICE("  Failed to write data to temporary file");
      return rv;
    }
  }

  inputStream->Close();
  rv = outputStream->Close();
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  Failed to write data to temporary file");
    return rv;
  }

  nsCOMPtr<nsIURI> uri;
  rv = NS_NewFileURI(getter_AddRefs(uri), tmpDir);
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  Failed to get file URI");
    return rv;
  }
  nsCOMPtr<nsIURL> fileURL(do_QueryInterface(uri));
  if (!fileURL) {
    LOGDRAGSERVICE("  Failed to query file interface");
    return NS_ERROR_FAILURE;
  }
  rv = fileURL->GetSpec(aURI);
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  Failed to get filepath");
    return rv;
  }

  // store url of temporary file
  mTempFileUrls.AppendElement()->Assign(aURI);
  LOGDRAGSERVICE("  storing tmp file as %s", PromiseFlatCString(aURI).get());
  return NS_OK;
}

bool nsDragSession::SourceDataAppendURLFileItem(nsACString& aURI,
                                                nsITransferable* aItem) {
  // If there is a file available, create a URI from the file.
  nsCOMPtr<nsISupports> data;
  nsresult rv = aItem->GetTransferData(kFileMime, getter_AddRefs(data));
  NS_ENSURE_SUCCESS(rv, false);
  if (nsCOMPtr<nsIFile> file = do_QueryInterface(data)) {
    nsCOMPtr<nsIURI> fileURI;
    NS_NewFileURI(getter_AddRefs(fileURI), file);
    if (fileURI) {
      fileURI->GetSpec(aURI);
      return true;
    }
  }
  return false;
}

bool nsDragSession::SourceDataAppendURLItem(nsITransferable* aItem,
                                            bool aExternalDrop,
                                            nsACString& aURI) {
  nsCOMPtr<nsISupports> data;
  nsresult rv = aItem->GetTransferData(kURLMime, getter_AddRefs(data));
  if (NS_FAILED(rv)) {
    return SourceDataAppendURLFileItem(aURI, aItem);
  }

  nsCOMPtr<nsISupportsString> string = do_QueryInterface(data);
  if (!string) {
    return false;
  }

  nsAutoString text;
  string->GetData(text);
  if (!aExternalDrop || CanExportAsURLTarget(text.get(), text.Length())) {
    AppendUTF16toUTF8(text, aURI);
    return true;
  }

  // We're dropping to another application and the URL can't be exported
  // as it's internal one (mailbox:// etc.)
  // Try to get file target directly.
  if (SourceDataAppendURLFileItem(aURI, aItem)) {
    return true;
  }

  // We can't get the file directly so try to download it and save to tmp.
  // The desktop or file manager expects for drags of promise-file data
  // the text/uri-list flavor set to a temporary file that contains the
  // promise-file data.
  // We open a stream on the <protocol>:// url here and save the content
  // to file:///tmp/dnd_file/<filename> and pass this url
  // as text/uri-list flavor.

  // check whether transferable contains FilePromiseUrl flavor...
  nsCOMPtr<nsISupports> promiseData;
  rv = aItem->GetTransferData(kFilePromiseURLMime, getter_AddRefs(promiseData));
  NS_ENSURE_SUCCESS(rv, false);

  // ... if so, create a temporary file and pass its url
  return NS_SUCCEEDED(CreateTempFile(aItem, aURI));
}

void nsDragSession::SourceDataGetUriList(GdkDragContext* aContext,
                                         GtkSelectionData* aSelectionData,
                                         uint32_t aDragItems) {
  // Check if we're transferring data to another application.
  // gdk_drag_context_get_dest_window() on X11 returns GdkWindow even for
  // different application so use nsWindow::GetWindow() to check if that's
  // our window.
  const bool isExternalDrop =
      widget::GdkIsX11Display()
          ? !nsWindow::GetWindow(gdk_drag_context_get_dest_window(aContext))
          : !gdk_drag_context_get_dest_window(aContext);

  LOGDRAGSERVICE("nsDragSession::SourceDataGetUriLists() len %d external %d",
                 aDragItems, isExternalDrop);

  // Disable processing of native events until we store all files to /tmp.
  // Otherwise user can quit drop before we have all files saved
  // and that cancels whole D&D.
  AutoSuspendNativeEvents suspend;

  nsAutoCString uriList;
  for (uint32_t i = 0; i < aDragItems; i++) {
    nsCOMPtr<nsITransferable> item = do_QueryElementAt(mSourceDataItems, i);
    if (!item) {
      continue;
    }
    nsAutoCString uri;
    if (!SourceDataAppendURLItem(item, isExternalDrop, uri)) {
      continue;
    }
    // text/x-moz-url is of form url + "\n" + title.
    // We just want the url.
    int32_t separatorPos = uri.FindChar(u'\n');
    if (separatorPos >= 0) {
      uri.Truncate(separatorPos);
    }
    uriList.Append(uri);
    uriList.AppendLiteral("\r\n");
  }

  LOGDRAGSERVICE("URI list\n%s", uriList.get());
  GdkAtom target = gtk_selection_data_get_target(aSelectionData);
  gtk_selection_data_set(aSelectionData, target, 8, (guchar*)uriList.get(),
                         uriList.Length());
}

bool nsDragSession::SourceDataGetImage(nsITransferable* aItem,
                                       GtkSelectionData* aSelectionData) {
  LOGDRAGSERVICE("nsDragSession::SourceDataGetImage()");

  nsresult rv;
  nsCOMPtr<nsISupports> data;
  rv = aItem->GetTransferData(kNativeImageMime, getter_AddRefs(data));
  NS_ENSURE_SUCCESS(rv, false);

  LOGDRAGSERVICE("  posting image\n");
  nsCOMPtr<imgIContainer> image = do_QueryInterface(data);
  if (!image) {
    LOGDRAGSERVICE("  do_QueryInterface failed\n");
    return false;
  }
  RefPtr<GdkPixbuf> pixbuf = nsImageToPixbuf::ImageToPixbuf(image);
  if (!pixbuf) {
    LOGDRAGSERVICE("  ImageToPixbuf failed\n");
    return false;
  }
  gtk_selection_data_set_pixbuf(aSelectionData, pixbuf);
  LOGDRAGSERVICE("  image data set\n");
  return true;
}

bool nsDragSession::SourceDataGetXDND(nsITransferable* aItem,
                                      GdkDragContext* aContext,
                                      GtkSelectionData* aSelectionData) {
  LOGDRAGSERVICE("nsDragSession::SourceDataGetXDND");

  // Indicate failure by default.
  GdkAtom target = gtk_selection_data_get_target(aSelectionData);
  gtk_selection_data_set(aSelectionData, target, 8, (guchar*)"E", 1);

  GdkWindow* srcWindow = gdk_drag_context_get_source_window(aContext);
  if (!srcWindow) {
    LOGDRAGSERVICE("  failed to get source GdkWindow!");
    return false;
  }

  // Ensure null termination.
  nsAutoCString data;
  {
    GUniquePtr<guchar> gdata;
    gint length = 0;
    if (!gdk_property_get(srcWindow, sXdndDirectSaveTypeAtom, sTextMimeAtom, 0,
                          INT32_MAX, FALSE, nullptr, nullptr, &length,
                          getter_Transfers(gdata))) {
      LOGDRAGSERVICE("  failed to get gXdndDirectSaveType GdkWindow property.");
      return false;
    }
    data.Assign(nsDependentCSubstring((const char*)gdata.get(), length));
  }

  GUniquePtr<char> hostname;
  GUniquePtr<char> fullpath(
      g_filename_from_uri(data.get(), getter_Transfers(hostname), nullptr));
  if (!fullpath) {
    LOGDRAGSERVICE("  failed to get file from uri.");
    return false;
  }

  // If there is no hostname in the URI, NULL will be stored.
  // We should not accept uris with from a different host.
  if (hostname) {
    nsCOMPtr<nsIPropertyBag2> infoService =
        do_GetService(NS_SYSTEMINFO_CONTRACTID);
    if (!infoService) {
      return false;
    }
    nsAutoCString host;
    if (NS_SUCCEEDED(infoService->GetPropertyAsACString(u"host"_ns, host))) {
      if (!host.Equals(hostname.get())) {
        LOGDRAGSERVICE("  ignored drag because of different host.");
        // Special error code "F" for this case.
        gtk_selection_data_set(aSelectionData, target, 8, (guchar*)"F", 1);
        return true;
      }
    }
  }

  LOGDRAGSERVICE("  XdndDirectSave filepath is %s", fullpath.get());

  nsCOMPtr<nsIFile> file;
  if (NS_FAILED(NS_NewNativeLocalFile(nsDependentCString(fullpath.get()),
                                      getter_AddRefs(file)))) {
    LOGDRAGSERVICE("  failed to get local file");
    return false;
  }

  // We have to split the path into a directory and filename,
  // because our internal file-promise API is based on these.
  nsCOMPtr<nsIFile> directory;
  file->GetParent(getter_AddRefs(directory));

  aItem->SetTransferData(kFilePromiseDirectoryMime, directory);

  nsCOMPtr<nsISupportsString> filenamePrimitive =
      do_CreateInstance(NS_SUPPORTS_STRING_CONTRACTID);
  if (!filenamePrimitive) {
    return false;
  }

  nsAutoString leafName;
  file->GetLeafName(leafName);
  filenamePrimitive->SetData(leafName);

  aItem->SetTransferData(kFilePromiseDestFilename, filenamePrimitive);

  nsCOMPtr<nsISupports> promiseData;
  nsresult rv =
      aItem->GetTransferData(kFilePromiseMime, getter_AddRefs(promiseData));
  NS_ENSURE_SUCCESS(rv, false);

  // Indicate success.
  gtk_selection_data_set(aSelectionData, target, 8, (guchar*)"S", 1);
  return true;
}

bool nsDragSession::SourceDataGetText(nsITransferable* aItem,
                                      const nsACString& aMIMEType,
                                      bool aNeedToDoConversionToPlainText,
                                      GtkSelectionData* aSelectionData) {
  LOGDRAGSERVICE("nsDragSession::SourceDataGetPlain()");

  nsresult rv;
  nsCOMPtr<nsISupports> data;
  rv = aItem->GetTransferData(PromiseFlatCString(aMIMEType).get(),
                              getter_AddRefs(data));
  NS_ENSURE_SUCCESS(rv, false);

  void* tmpData = nullptr;
  uint32_t tmpDataLen = 0;

  nsPrimitiveHelpers::CreateDataFromPrimitive(aMIMEType, data, &tmpData,
                                              &tmpDataLen);
  // if required, do the extra work to convert unicode to plain
  // text and replace the output values with the plain text.
  if (aNeedToDoConversionToPlainText) {
    char* plainTextData = nullptr;
    char16_t* castedUnicode = reinterpret_cast<char16_t*>(tmpData);
    uint32_t plainTextLen = 0;
    UTF16ToNewUTF8(castedUnicode, tmpDataLen / 2, &plainTextData,
                   &plainTextLen);
    if (tmpData) {
      // this was not allocated using glib
      free(tmpData);
      tmpData = plainTextData;
      tmpDataLen = plainTextLen;
    }
  }
  if (tmpData) {
    // this copies the data
    GdkAtom target = gtk_selection_data_get_target(aSelectionData);
    gtk_selection_data_set(aSelectionData, target, 8, (guchar*)tmpData,
                           tmpDataLen);
    // this wasn't allocated with glib
    free(tmpData);
  }

  return true;
}

// We're asked to get data from mSourceDataItems and pass it to
// GtkSelectionData (Gtk D&D interface).
// We need to check mSourceDataItems data type and try to convert it
// to data type accepted by Gtk.
void nsDragSession::SourceDataGet(GtkWidget* aWidget, GdkDragContext* aContext,
                                  GtkSelectionData* aSelectionData,
                                  guint32 aTime) {
  GdkAtom requestedFlavor = gtk_selection_data_get_target(aSelectionData);
  LOGDRAGSERVICE("nsDragSession::SourceDataGet(%p) MIME %s", aContext,
                 GUniquePtr<gchar>(gdk_atom_name(requestedFlavor)).get());

  // check to make sure that we have data items to return.
  if (!mSourceDataItems) {
    LOGDRAGSERVICE("  Failed to get our data items\n");
    return;
  }

  uint32_t dragItems;
  mSourceDataItems->GetLength(&dragItems);
  LOGDRAGSERVICE("  source data items %d", dragItems);

  if (requestedFlavor == sTextUriListTypeAtom) {
    SourceDataGetUriList(aContext, aSelectionData, dragItems);
    return;
  }

#ifdef MOZ_LOGGING
  if (dragItems > 1) {
    LOGDRAGSERVICE(
        "  There are %d data items but we're asked for %s MIME type. Only "
        "first data element can be transferred!",
        dragItems, GUniquePtr<gchar>(gdk_atom_name(requestedFlavor)).get());
  }
#endif

  nsCOMPtr<nsITransferable> item = do_QueryElementAt(mSourceDataItems, 0);
  if (!item) {
    LOGDRAGSERVICE("  Failed to get SourceDataItems!");
    return;
  }

  if (IsTextFlavor(requestedFlavor)) {
    if (!SourceDataGetText(item, nsDependentCString(kTextMime),
                           /* aNeedToDoConversionToPlainText */ true,
                           aSelectionData)) {
      LOGDRAGSERVICE(
          "  Failed to send sTextMimeAtom/sTextPlainUTF8TypeAtom data!");
    }
    // no fallback for text mime types
    return;
  }
  // Someone is asking for the special Direct Save Protocol type.
  else if (requestedFlavor == sXdndDirectSaveTypeAtom) {
    if (!SourceDataGetXDND(item, aContext, aSelectionData)) {
      LOGDRAGSERVICE("  Failed to send sXdndDirectSaveTypeAtom data!");
    }
    // no fallback for XDND mime types
    return;
  } else if (requestedFlavor == sPNGImageMimeAtom ||
             requestedFlavor == sJPEGImageMimeAtom ||
             requestedFlavor == sJPGImageMimeAtom ||
             requestedFlavor == sGIFImageMimeAtom) {
    // no fallback for image mime types
    if (!SourceDataGetImage(item, aSelectionData)) {
      LOGDRAGSERVICE("  Failed to send image data!");
    }
    return;
  } else if (requestedFlavor == sMozUrlTypeAtom) {
    // Someone was asking for _NETSCAPE_URL. We need to get it from
    // transferable as x-moz-url and convert it to plain text.
    // No need to check
    if (SourceDataGetText(item, nsDependentCString(kURLMime),
                          /* aNeedToDoConversionToPlainText */ true,
                          aSelectionData)) {
      LOGDRAGSERVICE("  Failed to send kURLMime data!");
      return;
    }
  }
  // Just try to get and set whatever we're asked for.
  GUniquePtr<gchar> flavorName(gdk_atom_name(requestedFlavor));

  // text/html is stored internally as UTF-16 but must be sent as UTF-8 over
  // X11 DnD, matching the clipboard write path.  Prepend kHTMLMarkupPrefix so
  // that DecodeHTMLData on the receiving side finds the charset declaration.
  if (nsDependentCString(flavorName.get()).EqualsLiteral(kHTMLMime)) {
    nsCOMPtr<nsISupports> data;
    if (NS_FAILED(item->GetTransferData(kHTMLMime, getter_AddRefs(data))) ||
        !data) {
      LOGDRAGSERVICE("  Failed to get kHTMLMime data!");
      return;
    }
    nsCOMPtr<nsISupportsString> wideString = do_QueryInterface(data);
    if (!wideString) {
      // Consistent with the clipboard write path: if the data is not a wide
      // string there is nothing sensible to send.
      LOGDRAGSERVICE("  kHTMLMime data is not nsISupportsString");
      return;
    }
    nsAutoString ucs2string;
    wideString->GetData(ucs2string);
    nsAutoCString html;
    html.AppendLiteral(mozilla::widget::kHTMLMarkupPrefix);
    AppendUTF16toUTF8(ucs2string, html);
    GdkAtom target = gtk_selection_data_get_target(aSelectionData);
    gtk_selection_data_set(aSelectionData, target, 8, (const guchar*)html.get(),
                           html.Length());
    return;
  }

  if (!SourceDataGetText(item, nsDependentCString(flavorName.get()),
                         /* aNeedToDoConversionToPlainText */ false,
                         aSelectionData)) {
    LOGDRAGSERVICE("  Failed to send %s data!",
                   nsDependentCString(flavorName.get()).get());
  }
}

void nsDragSession::SourceBeginDrag(GdkDragContext* aContext) {
  LOGDRAGSERVICE("nsDragSession::SourceBeginDrag(%p)\n", aContext);

  nsCOMPtr<nsITransferable> transferable =
      do_QueryElementAt(mSourceDataItems, 0);
  if (!transferable) {
    LOGDRAGSERVICE("  missing transferable!");
    return;
  }

  nsTArray<nsCString> flavors;
  nsresult rv = transferable->FlavorsTransferableCanImport(flavors);
  if (NS_FAILED(rv)) {
    LOGDRAGSERVICE("  FlavorsTransferableCanImport failed!");
    return;
  }

  for (uint32_t i = 0; i < flavors.Length(); ++i) {
    if (flavors[i].EqualsLiteral(kFilePromiseDestFilename)) {
      nsCOMPtr<nsISupports> data;
      rv = transferable->GetTransferData(kFilePromiseDestFilename,
                                         getter_AddRefs(data));
      if (NS_FAILED(rv)) {
        LOGDRAGSERVICE("  transferable doesn't contain '%s",
                       kFilePromiseDestFilename);
        return;
      }

      nsCOMPtr<nsISupportsString> fileName = do_QueryInterface(data);
      if (!fileName) {
        LOGDRAGSERVICE("  failed to get file name");
        return;
      }

      nsAutoString fileNameStr;
      fileName->GetData(fileNameStr);

      nsCString fileNameCStr;
      CopyUTF16toUTF8(fileNameStr, fileNameCStr);

      gdk_property_change(
          gdk_drag_context_get_source_window(aContext), sXdndDirectSaveTypeAtom,
          sTextMimeAtom, 8, GDK_PROP_MODE_REPLACE,
          (const guchar*)fileNameCStr.get(), fileNameCStr.Length());
      break;
    }
  }
}

bool nsDragSession::SetAlphaPixmap(SourceSurface* aSurface,
                                   GdkDragContext* aContext, int32_t aXOffset,
                                   int32_t aYOffset,
                                   const LayoutDeviceIntRect& dragRect) {
  GdkScreen* screen = gtk_widget_get_screen(mHiddenWidget);

  // Transparent drag icons need, like a lot of transparency-related things,
  // a compositing X window manager
  if (!gdk_screen_is_composited(screen)) {
    return false;
  }

#ifdef cairo_image_surface_create
#  error "Looks like we're including Mozilla's cairo instead of system cairo"
#endif

  // TODO: grab X11 pixmap or image data instead of expensive readback.
  cairo_surface_t* surf = cairo_image_surface_create(
      CAIRO_FORMAT_ARGB32, dragRect.width, dragRect.height);
  if (!surf) return false;

  RefPtr<DrawTarget> dt = gfxPlatform::CreateDrawTargetForData(
      cairo_image_surface_get_data(surf),
      nsIntSize(dragRect.width, dragRect.height),
      cairo_image_surface_get_stride(surf), SurfaceFormat::B8G8R8A8);
  if (!dt) return false;

  dt->ClearRect(Rect(0, 0, dragRect.width, dragRect.height));
  dt->DrawSurface(
      aSurface, Rect(0, 0, dragRect.width, dragRect.height),
      Rect(0, 0, dragRect.width, dragRect.height), DrawSurfaceOptions(),
      DrawOptions(DRAG_IMAGE_ALPHA_LEVEL, CompositionOp::OP_SOURCE));

  cairo_surface_mark_dirty(surf);
  cairo_surface_set_device_offset(surf, -aXOffset, -aYOffset);

  // Ensure that the surface is drawn at the correct scale on HiDPI displays.
  static auto sCairoSurfaceSetDeviceScalePtr =
      (void (*)(cairo_surface_t*, double, double))dlsym(
          RTLD_DEFAULT, "cairo_surface_set_device_scale");
  if (sCairoSurfaceSetDeviceScalePtr) {
    gint scale = mozilla::widget::ScreenHelperGTK::GetGTKMonitorScaleFactor();
    sCairoSurfaceSetDeviceScalePtr(surf, scale, scale);
  }

  gtk_drag_set_icon_surface(aContext, surf);
  cairo_surface_destroy(surf);
  return true;
}

void nsDragSession::SetDragIcon(GdkDragContext* aContext) {
  if (!mHasImage && !mSelection) return;

  LOGDRAGSERVICE("nsDragSession::SetDragIcon(%p)", aContext);

  LayoutDeviceIntRect dragRect;
  nsPresContext* pc;
  RefPtr<SourceSurface> surface;
  DrawDrag(mSourceNode, mRegion, mScreenPosition, &dragRect, &surface, &pc);
  if (!pc) {
    LOGDRAGSERVICE("  PresContext is missing!");
    return;
  }

  const auto screenPoint =
      LayoutDeviceIntPoint::Round(mScreenPosition * pc->CSSToDevPixelScale());
  int32_t offsetX = screenPoint.x - dragRect.x;
  int32_t offsetY = screenPoint.y - dragRect.y;

  // If a popup is set as the drag image, use its widget. Otherwise, use
  // the surface that DrawDrag created.
  //
  // XXX: Disable drag popups on GTK 3.19.4 and above: see bug 1264454.
  //      Fix this once a new GTK version ships that does not destroy our
  //      widget in gtk_drag_set_icon_widget.
  //      This is fixed in GTK 3.24
  //      by
  //      https://gitlab.gnome.org/GNOME/gtk/-/commit/c27c4e2048acb630feb24c31288f802345e99f4c
  bool gtk_drag_set_icon_widget_is_working =
      gtk_check_version(3, 19, 4) != nullptr ||
      gtk_check_version(3, 24, 0) == nullptr;
  if (mDragPopup && gtk_drag_set_icon_widget_is_working) {
    GtkWidget* gtkWidget = nullptr;
    nsIFrame* frame = mDragPopup->GetPrimaryFrame();
    if (frame) {
      // DrawDrag ensured that this is a popup frame.
      nsCOMPtr<nsIWidget> widget = frame->GetNearestWidget();
      if (widget) {
        gtkWidget = (GtkWidget*)widget->GetNativeData(NS_NATIVE_SHELLWIDGET);
        if (gtkWidget) {
          // When mDragPopup has a parent it's already attached to D&D context.
          // That may happens when D&D operation is aborted but not finished
          // on Gtk side yet so let's remove it now.
          g_object_ref(gtkWidget);
          if (GtkWidget* parent = gtk_widget_get_parent(gtkWidget)) {
            gtk_container_remove(GTK_CONTAINER(parent), gtkWidget);
          }
          LOGDRAGSERVICE("  set drag popup [%p]", widget.get());
          OpenDragPopup();
          gtk_drag_set_icon_widget(aContext, gtkWidget, offsetX, offsetY);
          g_object_unref(gtkWidget);
          return;
        } else {
          LOGDRAGSERVICE("  NS_NATIVE_SHELLWIDGET is missing!");
        }
      } else {
        LOGDRAGSERVICE("  NearestWidget is missing!");
      }
    } else {
      LOGDRAGSERVICE("  PrimaryFrame is missing!");
    }
  }

  if (surface) {
    LOGDRAGSERVICE("  We have a surface");
    if (!SetAlphaPixmap(surface, aContext, offsetX, offsetY, dragRect)) {
      RefPtr<GdkPixbuf> dragPixbuf = nsImageToPixbuf::SourceSurfaceToPixbuf(
          surface, dragRect.width, dragRect.height);
      if (dragPixbuf) {
        LOGDRAGSERVICE("  set drag pixbuf");
        gtk_drag_set_icon_pixbuf(aContext, dragPixbuf, offsetX, offsetY);
      } else {
        LOGDRAGSERVICE("  SourceSurfaceToPixbuf failed!");
      }
    }
  } else {
    LOGDRAGSERVICE("  Surface is missing!");
  }
}

static void invisibleSourceDragBegin(GtkWidget* aWidget,
                                     GdkDragContext* aContext, gpointer aData) {
  LOGDRAGSERVICESTATIC("invisibleSourceDragBegin (%p)", aContext);
  nsDragSession* dragSession = (nsDragSession*)aData;

  dragSession->SourceBeginDrag(aContext);
  dragSession->SetDragIcon(aContext);
}

static void invisibleSourceDragDataGet(GtkWidget* aWidget,
                                       GdkDragContext* aContext,
                                       GtkSelectionData* aSelectionData,
                                       guint aInfo, guint32 aTime,
                                       gpointer aData) {
  LOGDRAGSERVICESTATIC("invisibleSourceDragDataGet (%p)", aContext);
  nsDragSession* dragSession = (nsDragSession*)aData;
  dragSession->SourceDataGet(aWidget, aContext, aSelectionData, aTime);
}

static gboolean invisibleSourceDragFailed(GtkWidget* aWidget,
                                          GdkDragContext* aContext,
                                          gint aResult, gpointer aData) {
  // Wayland and X11 uses different drag results here. When drag target is
  // missing X11 passes GDK_DRAG_CANCEL_NO_TARGET
  // (from gdk_dnd_handle_button_event()/gdkdnd-x11.c)
  // as backend X11 has info about other application windows.
  // Wayland does not have such info so it always passes
  // GDK_DRAG_CANCEL_ERROR error code
  // (see data_source_cancelled/gdkselection-wayland.c).
  // Bug 1527976
  // Emulate what X11 does here as Gecko expect it and handles NO_TARGET
  // result correctly according to drop destination.
  if (widget::GdkIsWaylandDisplay() && aResult == GTK_DRAG_RESULT_ERROR) {
    aResult = GTK_DRAG_RESULT_NO_TARGET;
  }

  LOGDRAGSERVICESTATIC("invisibleSourceDragFailed(%p) %s", aContext,
                       kGtkDragResults[aResult]);
  nsDragSession* dragSession = (nsDragSession*)aData;
  // End the drag session now (rather than waiting for the drag-end signal)
  // so that operations performed on dropEffect == none can start immediately
  // rather than waiting for the drag-failed animation to finish.
  dragSession->SourceEndDragSession(aContext, aResult);

  // We should return TRUE to disable the drag-failed animation iff the
  // source performed an operation when dropEffect was none, but the handler
  // of the dragend DOM event doesn't provide this information.
  return FALSE;
}

static void invisibleSourceDragEnd(GtkWidget* aWidget, GdkDragContext* aContext,
                                   gpointer aData) {
  LOGDRAGSERVICESTATIC("invisibleSourceDragEnd(%p)", aContext);
  nsDragSession* dragSession = (nsDragSession*)aData;

  // The drag has ended.  Release the hostages!
  dragSession->SourceEndDragSession(aContext, GTK_DRAG_RESULT_SUCCESS);
}

#ifdef MOZ_LOGGING
const char* nsDragSession::GetDragServiceTaskName(DragTaskType aTask) {
  static const char* taskNames[] = {"eDragTaskNone", "eDragTaskMotion",
                                    "eDragTaskLeave", "eDragTaskDrop"};
  MOZ_ASSERT(size_t(aTask) < std::size(taskNames));
  return taskNames[aTask];
}
#endif

void nsDragSession::DispatchMotionEvents() {
  if (mSourceWindow) {
    FireDragEventAtSource(eDrag, GetCurrentModifiers());
  }
  if (mRecentTask->mWindow) {
    mRecentTask->mWindow->DispatchDragEvent(
        eDragOver, mRecentTask->mWindowPoint, mRecentTask->mTime);
  }
}

void nsDragSession::DispatchDropEvent() {
  // We need to check IsDestroyed here because the nsRefPtr
  // only protects this from being deleted, it does NOT protect
  // against nsView::~nsView() calling Destroy() on it, bug 378273.
  if (!mRecentTask->mWindow || mRecentTask->mWindow->IsDestroyed()) {
    return;
  }

  EventMessage msg = mCanDrop ? eDrop : eDragExit;

  mRecentTask->mWindow->DispatchDragEvent(msg, mRecentTask->mWindowPoint,
                                          mRecentTask->mTime);

  // Deliver message to OS
  DropFinish(mCanDrop);
}

int nsDragSession::RunScheduledTaskCallback(void* aData) {
  RefPtr<nsDragSession> dragSession = static_cast<nsDragSession*>(aData);
  nsDragSession::AutoEventLoop loop(dragSession);
  return dragSession->RunScheduledTask();
}

gboolean nsDragSession::Schedule(UniquePtr<DragTask> aTask) {
  LOGDRAGSERVICE("nsDragSession::Schedule()");
  if (mDragTaskSourceFinished) {
    LOGDRAGSERVICE("  already finished, quit.");
    return FALSE;
  }

  // If there is an existing leave or motion task scheduled, then that
  // will be replaced.  When the new task is run, it will dispatch
  // any necessary leave or motion events.
  // We don't replace eDragTaskDrop as it's final D&D event.
  if (mNextScheduledTask && mNextScheduledTask->mType == eDragTaskDrop) {
    LOGDRAGSERVICE("   eDragTaskDrop is a final one, can't be replaced by %s",
                   GetDragServiceTaskName(aTask->mType));
    return FALSE;
  }

  mNextScheduledTask = std::move(aTask);

  if (!mTaskSource) {
    // High priority is used here because we want to process motion events
    // right after drag_motion event handler which is called by Gtk.
    // An ideal scenario is to call RunScheduledTask() directly here
    // but we can't do that. RunScheduledTask() spins gtk event loop
    // while nsDragSession::Schedule() is already called from event loop
    // (by drag_motion* gtk_widget events) so that direct call will cause
    // nested recursion.
    // RunScheduledTask returns false to stop getting callbacks
    // from mTaskSource.
    mTaskSource = g_timeout_add_full(G_PRIORITY_HIGH, 0,
                                     RunScheduledTaskCallback, this, nullptr);
  }

  // We need to reply to drag_motion event on Wayland immediately,
  // see Bug 1730203.
  if (widget::GdkIsWaylandDisplay() &&
      mNextScheduledTask->mType == eDragTaskMotion) {
    UpdateDragAction();
    ReplyToDragMotion();
  }

  return TRUE;
}

gboolean nsDragSession::RunScheduledTask() {
  // No task is present - remove the timer.
  if (!mNextScheduledTask || mDragTaskSourceFinished) {
    LOGDRAGSERVICE(
        "nsDragSession::RunScheduledTask(): no task is scheduled or it's "
        "finished [%d], quit.",
        mDragTaskSourceFinished);
    mTaskSource = 0;
    return false;
  }

  // Don't run RunScheduledTask() twice. As we use it in main thread only
  // we don't need to be thread safe here. But don't remove mTaskSource -
  // call the RunScheduledTask() again later when recent task is finished.
  if (mScheduledTaskIsRunning) {
    return true;
  }

  AutoRestore<bool> guard(mScheduledTaskIsRunning);
  mScheduledTaskIsRunning = true;

  LOGDRAGSERVICE("nsDragSession::RunScheduledTask() begin");

  RunScheduledTask(std::move(mNextScheduledTask));

  LOGDRAGSERVICE("nsDragSession::RunScheduledTask() end");

  // We have pending task (may be added by nested loops
  // at RunScheduledTask()) - ask for next timer callback.
  if (mNextScheduledTask) {
    return true;
  }

  // We don't have any additional task in queue so terminate the timer.
  mTaskSource = 0;
  return false;
}

void nsDragSession::RunScheduledTask(
    mozilla::UniquePtr<DragTask> aScheduledTask) {
  MOZ_DIAGNOSTIC_ASSERT(
      mScheduledTaskIsRunning,
      "Running outside of nsDragSession::RunScheduledTask()?");

  LOGDRAGSERVICE(
      "nsDragSession::RunScheduledTask() task %s recent Window %p scheduled "
      "Window %p\n",
      GetDragServiceTaskName(aScheduledTask->mType), mRecentTask->mWindow.get(),
      aScheduledTask->mWindow.get());

  if (mRecentTask->mWindow && mRecentTask->mWindow != aScheduledTask->mWindow) {
    LOGDRAGSERVICE(
        "  window changed, dispatch eDragExit to leaved window (%p)\n",
        mRecentTask->mWindow.get());
    mRecentTask->mWindow->DispatchDragEvent(eDragExit,
                                            aScheduledTask->mWindowPoint, 0);

    if (!mSourceNode) {
      // The drag that was initiated in a different app. End the drag
      // session, since we're done with it for now (until the user drags
      // back into this app).
      EndDragSession(false, GetCurrentModifiers());
    }
  }

  if (aScheduledTask->mType == eDragTaskLeave) {
    LOGDRAGSERVICE("  quit, selected task %s\n",
                   GetDragServiceTaskName(aScheduledTask->mType));
    // Nothing more to do
    // Returning false removes the task source from the event loop.
    mRecentTask->Reset();
    return;
  }
  // We process eDragTaskMotion or eDragTaskDrop from now.

  // It is possible that the pending state has been updated during dispatch
  // of the leave event.  That's fine.

  // Now we collect the pending state because, from this point on, we want
  // to use the same state for all events dispatched.  All state is updated
  // so that when other tasks are scheduled during dispatch here, this
  // task is considered to have already been run.
  bool positionHasChanged =
      aScheduledTask->mWindow != mRecentTask->mWindow ||
      aScheduledTask->mWindowPoint != mRecentTask->mWindowPoint;

  mRecentTask = std::move(aScheduledTask);

  LOGDRAGSERVICE(
      "  start drag session Window %p GtkWidget %p", mRecentTask->mWindow.get(),
      mRecentTask->mWindow ? mRecentTask->mWindow->GetGtkWidget() : nullptr);

  SetCachedDragContext(mRecentTask->GetContextID());

  // http://www.whatwg.org/specs/web-apps/current-work/multipage/dnd.html#drag-and-drop-processing-model
  // (as at 27 December 2010) indicates that a "drop" event should only be
  // fired (at the current target element) if the current drag operation is
  // not none.  The current drag operation will only be set to a non-none
  // value during a "dragover" event.
  //
  // If the user has ended the drag before any dragover events have been
  // sent, then the spec recommends skipping the drop (because the current
  // drag operation is none).  However, here we assume that, by releasing
  // the mouse button, the user has indicated that they want to drop, so we
  // proceed with the drop where possible.
  //
  // In order to make the events appear to content in the same way as if the
  // spec is being followed we make sure to dispatch a "dragover" event with
  // appropriate coordinates and check canDrop before the "drop" event.
  //
  // When the Xdnd protocol is used for source/destination communication (as
  // should be the case with GTK source applications) a dragover event
  // should have already been sent during the drag-motion signal, which
  // would have already been received because XdndDrop messages do not
  // contain a position.  However, we can't assume the same when the Motif
  // protocol is used.
  if (mRecentTask->mType == eDragTaskMotion || positionHasChanged) {
    LOGDRAGSERVICE("  process motion event\n");
    UpdateDragAction();
    TakeDragEventDispatchedToChildProcess();  // Clear the old value.
    DispatchMotionEvents();
    if (mRecentTask->mType == eDragTaskMotion) {
      if (TakeDragEventDispatchedToChildProcess()) {
        SetRemoteContext();
      } else {
        // Reply to tell the source whether we can drop and what
        // action would be taken.
        ReplyToDragMotion();
      }
    }
  }

  if (mRecentTask->mType == eDragTaskDrop) {
    LOGDRAGSERVICE("  process drop task\n");
    DispatchDropEvent();

    // Make sure to end the drag session. If this drag started in a
    // different app, we won't get a drag_end signal to end it from.
    EndDragSession(true, GetCurrentModifiers());
  }
}

void nsDragSession::SetDragActionGtk(GdkDragAction aGdkAction) {
  LOGDRAGSERVICE("nsDragSession::SetDragActionGtk() action [%d]", aGdkAction);

  // default is to do nothing
  int action = nsIDragService::DRAGDROP_ACTION_NONE;

  // set the default just in case nothing matches below
  if (aGdkAction & GDK_ACTION_DEFAULT) {
    LOGDRAGSERVICE("nsDragSession::UpdateDragActionGtk(): set default move");
    action = nsIDragService::DRAGDROP_ACTION_MOVE;
  }
  // first check to see if move is set
  if (aGdkAction & GDK_ACTION_MOVE) {
    LOGDRAGSERVICE("nsDragSession::UpdateDragActionGtk(): set explicit move");
    action = nsIDragService::DRAGDROP_ACTION_MOVE;
  } else if (aGdkAction & GDK_ACTION_LINK) {
    // then fall to the others
    LOGDRAGSERVICE("nsDragSession::UpdateDragActionGtk(): set explicit link");
    action = nsIDragService::DRAGDROP_ACTION_LINK;
  } else if (aGdkAction & GDK_ACTION_COPY) {
    // copy is ctrl
    LOGDRAGSERVICE("nsDragSession::UpdateDragActionGtk(): set explicit copy");
    action = nsIDragService::DRAGDROP_ACTION_COPY;
  }

  // update the drag information
  SetDragAction(action);
}

GdkDragAction nsDragSession::GetDragActionGtk() {
  GdkDragAction action = (GdkDragAction)0;
  if (mCanDrop) {
    // notify the dragger if we can drop
    switch (mDragAction) {
      case nsIDragService::DRAGDROP_ACTION_COPY:
        action = GDK_ACTION_COPY;
        break;
      case nsIDragService::DRAGDROP_ACTION_LINK:
        action = GDK_ACTION_LINK;
        break;
      // if mCanDrop we switch DRAGDROP_ACTION_NONE to default.
      case nsIDragService::DRAGDROP_ACTION_NONE:
      default:
        action = GDK_ACTION_MOVE;
        break;
    }
  }
  LOGDRAGSERVICE(
      "nsDragSession::GetDragActionGtk() can drop %d mDragAction %d GdkAction "
      "%d",
      mCanDrop, mDragAction, action);
  return action;
}

/* static */
uint32_t nsDragSession::GetCurrentModifiers() {
  return mozilla::widget::KeymapWrapper::ComputeCurrentKeyModifiers();
}

nsAutoCString nsDragSession::GetDebugTag() const {
  nsAutoCString tag;
  tag.AppendPrintf("[%p]", this);
  return tag;
}

/* static */
bool nsDragSession::IsTextFlavor(GdkAtom aFlavor) {
  return aFlavor == nsDragSession::sTextMimeAtom ||
         aFlavor == nsDragSession::sTextPlainUTF8TypeAtom ||
         aFlavor == nsDragSession::sUTF8STRINGMimeAtom ||
         aFlavor == nsDragSession::sSTRINGMimeAtom;
}

nsDragSession::DragTask::DragTask(
    DragTaskType aType, nsWindow* aWindow,
    const mozilla::LayoutDeviceIntPoint& aWindowPoint, guint aTime)
    : mType(aType), mWindow(aWindow), mWindowPoint(aWindowPoint), mTime(aTime) {
      };

#undef LOGDRAGSERVICE
