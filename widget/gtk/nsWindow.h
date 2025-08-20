/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:expandtab:shiftwidth=2:tabstop=2:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __nsWindow_h__
#define __nsWindow_h__

#include <gdk/gdk.h>
#include <gtk/gtk.h>

#include "CompositorWidget.h"
#include "MozContainer.h"
#include "WaylandSurfaceLock.h"
#include "VsyncSource.h"
#include "mozilla/EventForwards.h"
#include "mozilla/Maybe.h"
#include "mozilla/RefPtr.h"
#include "mozilla/TouchEvents.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/RWLock.h"
#include "mozilla/gfx/BaseMargin.h"
#include "mozilla/widget/WindowSurface.h"
#include "mozilla/widget/WindowSurfaceProvider.h"
#include "nsBaseWidget.h"
#include "nsGkAtoms.h"
#include "nsIDragService.h"
#include "nsRefPtrHashtable.h"
#include "IMContextWrapper.h"
#include "LookAndFeel.h"

#include "nsMenuBar.h"

#ifdef ACCESSIBILITY
#  include "mozilla/a11y/LocalAccessible.h"
#endif

#ifdef MOZ_X11
#  include <gdk/gdkx.h>
#  include "X11UndefineNone.h"
#endif
#ifdef MOZ_WAYLAND
#  include <gdk/gdkwayland.h>
#  include "base/thread.h"
#  include "nsClipboardWayland.h"
#endif

#ifdef MOZ_LOGGING

#  undef LOG
#  undef LOGVERBOSE

#  include "mozilla/Logging.h"
#  include "nsTArray.h"
#  include "Units.h"

extern mozilla::LazyLogModule gWidgetLog;
extern mozilla::LazyLogModule gWidgetDragLog;
extern mozilla::LazyLogModule gWidgetPopupLog;
extern mozilla::LazyLogModule gWidgetVsync;
extern mozilla::LazyLogModule gWidgetWaylandLog;

#  define LOG(str, ...)                               \
    MOZ_LOG(IsPopup() ? gWidgetPopupLog : gWidgetLog, \
            mozilla::LogLevel::Debug,                 \
            ("%s: " str, GetDebugTag().get(), ##__VA_ARGS__))
#  define LOGVERBOSE(str, ...)                        \
    MOZ_LOG(IsPopup() ? gWidgetPopupLog : gWidgetLog, \
            mozilla::LogLevel::Verbose,               \
            ("%s: " str, GetDebugTag().get(), ##__VA_ARGS__))
#  define LOGW(...) MOZ_LOG(gWidgetLog, mozilla::LogLevel::Debug, (__VA_ARGS__))
#  define LOGDRAG(...) \
    MOZ_LOG(gWidgetDragLog, mozilla::LogLevel::Debug, (__VA_ARGS__))
#  define LOG_POPUP(...) \
    MOZ_LOG(gWidgetPopupLog, mozilla::LogLevel::Debug, (__VA_ARGS__))
#  define LOG_VSYNC(str, ...)                       \
    MOZ_LOG(gWidgetVsync, mozilla::LogLevel::Debug, \
            ("%s: " str, GetDebugTag().get(), ##__VA_ARGS__))
#  define LOG_ENABLED()                                         \
    (MOZ_LOG_TEST(gWidgetPopupLog, mozilla::LogLevel::Debug) || \
     MOZ_LOG_TEST(gWidgetLog, mozilla::LogLevel::Debug))
#  define LOG_ENABLED_VERBOSE()                                   \
    (MOZ_LOG_TEST(gWidgetPopupLog, mozilla::LogLevel::Verbose) || \
     MOZ_LOG_TEST(gWidgetLog, mozilla::LogLevel::Verbose))
#  define LOG_WAYLAND(...) \
    MOZ_LOG(gWidgetWaylandLog, mozilla::LogLevel::Debug, (__VA_ARGS__))

#else

#  define LOG(...)
#  define LOGVERBOSE(...)
#  define LOGW(...)
#  define LOGDRAG(...)
#  define LOG_POPUP(...)
#  define LOG_ENABLED() false

#endif /* MOZ_LOGGING */

#if defined(MOZ_WAYLAND) && !defined(MOZ_X11)
typedef uintptr_t Window;
#endif

class gfxPattern;
class nsIFrame;
#if !GTK_CHECK_VERSION(3, 18, 0)
struct _GdkEventTouchpadPinch;
typedef struct _GdkEventTouchpadPinch GdkEventTouchpadPinch;
#endif

#if !GTK_CHECK_VERSION(3, 22, 0)
typedef enum {
  GDK_ANCHOR_FLIP_X = 1 << 0,
  GDK_ANCHOR_FLIP_Y = 1 << 1,
  GDK_ANCHOR_SLIDE_X = 1 << 2,
  GDK_ANCHOR_SLIDE_Y = 1 << 3,
  GDK_ANCHOR_RESIZE_X = 1 << 4,
  GDK_ANCHOR_RESIZE_Y = 1 << 5,
  GDK_ANCHOR_FLIP = GDK_ANCHOR_FLIP_X | GDK_ANCHOR_FLIP_Y,
  GDK_ANCHOR_SLIDE = GDK_ANCHOR_SLIDE_X | GDK_ANCHOR_SLIDE_Y,
  GDK_ANCHOR_RESIZE = GDK_ANCHOR_RESIZE_X | GDK_ANCHOR_RESIZE_Y
} GdkAnchorHints;
#endif

#if !GTK_CHECK_VERSION(3, 18, 0)
typedef enum {
  GDK_TOUCHPAD_GESTURE_PHASE_BEGIN,
  GDK_TOUCHPAD_GESTURE_PHASE_UPDATE,
  GDK_TOUCHPAD_GESTURE_PHASE_END,
  GDK_TOUCHPAD_GESTURE_PHASE_CANCEL
} GdkTouchpadGesturePhase;
#endif

struct zwp_locked_pointer_v1;
struct zwp_relative_pointer_v1;

namespace mozilla {
enum class NativeKeyBindingsType : uint8_t;

class TimeStamp;
class WaylandVsyncSource;
#ifdef MOZ_X11
class CurrentX11TimeGetter;
#endif

namespace widget {
class DBusMenuBar;
class Screen;
class WaylandSurface;
class WaylandSurfaceLock;
}  // namespace widget
}  // namespace mozilla

class gfxImageSurface;

class nsWindow final : public nsBaseWidget {
 public:
  typedef mozilla::gfx::DrawTarget DrawTarget;
  typedef mozilla::WidgetEventTime WidgetEventTime;
  typedef mozilla::WidgetKeyboardEvent WidgetKeyboardEvent;
  typedef mozilla::widget::PlatformCompositorWidgetDelegate
      PlatformCompositorWidgetDelegate;

  nsWindow();

  static void ReleaseGlobals();

  NS_INLINE_DECL_REFCOUNTING_INHERITED(nsWindow, nsBaseWidget)

  nsresult DispatchEvent(mozilla::WidgetGUIEvent* aEvent,
                         nsEventStatus& aStatus) override;

  // called when we are destroyed
  void OnDestroy() override;

  // called to check and see if a widget's dimensions are sane
  bool AreBoundsSane();

  // nsIWidget
  using nsBaseWidget::Create;  // for Create signature not overridden here
  [[nodiscard]] nsresult Create(nsIWidget* aParent,
                                const LayoutDeviceIntRect& aRect,
                                InitData* aInitData) override;
  void Destroy() override;
  float GetDPI() override;
  double GetDefaultScaleInternal() override;
  mozilla::DesktopToLayoutDeviceScale GetDesktopToDeviceScale() override;
  mozilla::DesktopToLayoutDeviceScale GetDesktopToDeviceScaleByScreen()
      override;
  void SetModal(bool aModal) override;
  bool IsVisible() const override;
  bool IsMapped() const override;
  void ConstrainPosition(DesktopIntPoint&) override;
  void SetSizeConstraints(const SizeConstraints&) override;
  void LockAspectRatio(bool aShouldLock) override;
  void Move(double aX, double aY) override;
  void Show(bool aState) override;
  void Resize(double aWidth, double aHeight, bool aRepaint) override;
  void Resize(double aX, double aY, double aWidth, double aHeight,
              bool aRepaint) override;
  bool IsEnabled() const override;

  nsSizeMode SizeMode() override { return mSizeMode; }
  void SetSizeMode(nsSizeMode aMode) override;
  void GetWorkspaceID(nsAString& workspaceID) override;
  void MoveToWorkspace(const nsAString& workspaceID) override;
  void Enable(bool aState) override;
  void SetFocus(Raise, mozilla::dom::CallerType aCallerType) override;
  LayoutDeviceIntRect GetScreenBounds() override;
  LayoutDeviceIntRect GetClientBounds() override;
  LayoutDeviceIntSize GetClientSize() override;
  LayoutDeviceIntPoint GetClientOffset() override {
    return LayoutDeviceIntPoint(mClientMargin.left, mClientMargin.top);
  }
  GdkPoint GetCsdOffsetInGdkCoords();
  LayoutDeviceIntPoint GetScreenEdgeSlop() override;
  nsresult GetRestoredBounds(LayoutDeviceIntRect&) override;
  bool PersistClientBounds() const override { return true; }
  LayoutDeviceIntMargin NormalSizeModeClientToWindowMargin() override;

  void ConstrainSize(int* aWidth, int* aHeight) override;

  // Recomputes the bounds according to our current window position. Dispatches
  // move / resizes as needed.
  enum class MayChangeCsdMargin : bool { No = false, Yes };
  void RecomputeBounds(MayChangeCsdMargin);
  void SchedulePendingBounds(MayChangeCsdMargin);
  void MaybeRecomputeBounds();

  void SetCursor(const Cursor&) override;
  void Invalidate(const LayoutDeviceIntRect& aRect) override;
  void* GetNativeData(uint32_t aDataType) override;
  nsresult SetTitle(const nsAString& aTitle) override;
  void SetIcon(const nsAString& aIconSpec) override;
  void SetWindowClass(const nsAString& xulWinType, const nsAString& xulWinClass,
                      const nsAString& xulWinName) override;
  LayoutDeviceIntPoint WidgetToScreenOffset() override;
  void CaptureRollupEvents(bool aDoCapture) override;
  [[nodiscard]] nsresult GetAttention(int32_t aCycleCount) override;
  bool HasPendingInputEvent() override;

  bool PrepareForFullscreenTransition(nsISupports** aData) override;
  void PerformFullscreenTransition(FullscreenTransitionStage aStage,
                                   uint16_t aDuration, nsISupports* aData,
                                   nsIRunnable* aCallback) override;
  already_AddRefed<Screen> GetWidgetScreen() override;
  nsresult MakeFullScreen(bool aFullScreen) override;
  void HideWindowChrome(bool aShouldHide) override;

  void SetMenuBar(mozilla::UniquePtr<nsMenuBar> aMenuBar);

  /**
   * GetLastUserInputTime returns a timestamp for the most recent user input
   * event.  This is intended for pointer grab requests (including drags).
   */
  static guint32 GetLastUserInputTime();

  // utility method, -1 if no change should be made, otherwise returns a
  // value that can be passed to gdk_window_set_decorations
  gint ConvertBorderStyles(BorderStyle aStyle);

  mozilla::widget::IMContextWrapper* GetIMContext() const { return mIMContext; }

  bool DispatchCommandEvent(nsAtom* aCommand);
  bool DispatchContentCommandEvent(mozilla::EventMessage aMsg);

  // event callbacks
  gboolean OnExposeEvent(cairo_t* cr);
  gboolean OnShellConfigureEvent(GdkEventConfigure* aEvent);
  void OnContainerSizeAllocate(GtkAllocation* aAllocation);
  void OnMap();
  void OnUnmap();
  void OnDeleteEvent();
  void OnEnterNotifyEvent(GdkEventCrossing* aEvent);
  void OnLeaveNotifyEvent(GdkEventCrossing* aEvent);
  void OnMotionNotifyEvent(GdkEventMotion* aEvent);
  void OnButtonPressEvent(GdkEventButton* aEvent);
  void OnButtonReleaseEvent(GdkEventButton* aEvent);
  void OnContainerFocusInEvent(GdkEventFocus* aEvent);
  void OnContainerFocusOutEvent(GdkEventFocus* aEvent);
  gboolean OnKeyPressEvent(GdkEventKey* aEvent);
  gboolean OnKeyReleaseEvent(GdkEventKey* aEvent);

  void OnScrollEvent(GdkEventScroll* aEvent);
  void OnSmoothScrollEvent(uint32_t aTime, float aDeltaX, float aDeltaY);

  void OnVisibilityNotifyEvent(GdkVisibilityState aState);
  void OnWindowStateEvent(GtkWidget* aWidget, GdkEventWindowState* aEvent);
  void OnDragDataReceivedEvent(GtkWidget* aWidget, GdkDragContext* aDragContext,
                               gint aX, gint aY,
                               GtkSelectionData* aSelectionData, guint aInfo,
                               guint aTime, gpointer aData);
  gboolean OnPropertyNotifyEvent(GtkWidget* aWidget, GdkEventProperty* aEvent);
  gboolean OnTouchEvent(GdkEventTouch* aEvent);
  gboolean OnTouchpadPinchEvent(GdkEventTouchpadPinch* aEvent);
  void OnTouchpadHoldEvent(GdkTouchpadGesturePhase aPhase, guint aTime,
                           uint32_t aFingers);

  gint GetInputRegionMarginInGdkCoords();

  void UpdateOpaqueRegionInternal();
  void UpdateOpaqueRegion(const LayoutDeviceIntRegion&) override;
  LayoutDeviceIntRegion GetOpaqueRegionForTesting() const override {
    return GetOpaqueRegion();
  }
  LayoutDeviceIntRegion GetOpaqueRegion() const;

  already_AddRefed<mozilla::gfx::DrawTarget> StartRemoteDrawingInRegion(
      const LayoutDeviceIntRegion& aInvalidRegion) override;
  void EndRemoteDrawingInRegion(
      mozilla::gfx::DrawTarget* aDrawTarget,
      const LayoutDeviceIntRegion& aInvalidRegion) override;

  void SetProgress(unsigned long progressPercent);

  RefPtr<mozilla::VsyncDispatcher> GetVsyncDispatcher() override;
  bool SynchronouslyRepaintOnResize() override;

  void OnDPIChanged();
  void OnCheckResize();
  void OnCompositedChanged();
  void DispatchResized();
  void OnScaleEvent();

  // Load new scale from system.

  // aRefreshScreen means notify layout that scale was changed and
  //  it should load correct values.
  // Set aRefreshScreen to false if we operate on hidden window
  // or if we're going to repaint.
  void RefreshScale(bool aRefreshScreen);

  static guint32 sLastButtonPressTime;

  MozContainer* GetMozContainer() { return mContainer; }
  GdkWindow* GetGdkWindow() const { return mGdkWindow; };
  GdkWindow* GetToplevelGdkWindow() const;
  GtkWidget* GetGtkWidget() const { return mShell; }
  nsIFrame* GetFrame() const;
  nsWindow* GetEffectiveParent();
  bool IsDestroyed() const { return mIsDestroyed; }
  bool IsPopup() const;
  bool IsWaylandPopup() const;
  bool IsDragPopup() { return mIsDragPopup; };

  nsAutoCString GetDebugTag() const;

  void DispatchDragEvent(mozilla::EventMessage aMsg,
                         const LayoutDeviceIntPoint& aRefPoint, guint aTime);
  static void UpdateDragStatus(GdkDragContext* aDragContext,
                               nsIDragService* aDragService);
  void SetDragSource(GdkDragContext* aSourceDragContext);

  WidgetEventTime GetWidgetEventTime(guint32 aEventTime);
  mozilla::TimeStamp GetEventTimeStamp(guint32 aEventTime);
#ifdef MOZ_X11
  mozilla::CurrentX11TimeGetter* GetCurrentTimeGetter();
#endif

  void SetInputContext(const InputContext& aContext,
                       const InputContextAction& aAction) override;
  InputContext GetInputContext() override;
  TextEventDispatcherListener* GetNativeTextEventDispatcherListener() override;
  MOZ_CAN_RUN_SCRIPT bool GetEditCommands(
      mozilla::NativeKeyBindingsType aType,
      const mozilla::WidgetKeyboardEvent& aEvent,
      nsTArray<mozilla::CommandInt>& aCommands) override;

  void SetTransparencyMode(TransparencyMode aMode) override;
  TransparencyMode GetTransparencyMode() override;
  void SetInputRegion(const InputRegion&) override;

  nsresult SynthesizeNativeMouseEvent(LayoutDeviceIntPoint aPoint,
                                      NativeMouseMessage aNativeMessage,
                                      mozilla::MouseButton aButton,
                                      nsIWidget::Modifiers aModifierFlags,
                                      nsIObserver* aObserver) override;

  nsresult SynthesizeNativeMouseMove(LayoutDeviceIntPoint aPoint,
                                     nsIObserver* aObserver) override {
    return SynthesizeNativeMouseEvent(
        aPoint, NativeMouseMessage::Move, mozilla::MouseButton::eNotPressed,
        nsIWidget::Modifiers::NO_MODIFIERS, aObserver);
  }

  nsresult SynthesizeNativeMouseScrollEvent(
      LayoutDeviceIntPoint aPoint, uint32_t aNativeMessage, double aDeltaX,
      double aDeltaY, double aDeltaZ, uint32_t aModifierFlags,
      uint32_t aAdditionalFlags, nsIObserver* aObserver) override;

  nsresult SynthesizeNativeTouchPoint(uint32_t aPointerId,
                                      TouchPointerState aPointerState,
                                      LayoutDeviceIntPoint aPoint,
                                      double aPointerPressure,
                                      uint32_t aPointerOrientation,
                                      nsIObserver* aObserver) override;

  nsresult SynthesizeNativeTouchPadPinch(TouchpadGesturePhase aEventPhase,
                                         float aScale,
                                         LayoutDeviceIntPoint aPoint,
                                         int32_t aModifierFlags) override;

  nsresult SynthesizeNativeTouchpadPan(TouchpadGesturePhase aEventPhase,
                                       LayoutDeviceIntPoint aPoint,
                                       double aDeltaX, double aDeltaY,
                                       int32_t aModifierFlags,
                                       nsIObserver* aObserver) override;

  void GetCompositorWidgetInitData(
      mozilla::widget::CompositorWidgetInitData* aInitData) override;

  void SetCustomTitlebar(bool) override;
  void UpdateWindowDraggingRegion(
      const LayoutDeviceIntRegion& aRegion) override;

#ifdef MOZ_ENABLE_DBUS
  void SetDBusMenuBar(RefPtr<mozilla::widget::DBusMenuBar> aDbusMenuBar);
#endif

  // HiDPI scale conversion
  gint GdkCeiledScaleFactor();
  double FractionalScaleFactor();

  // To GDK
  gint DevicePixelsToGdkCoordRoundUp(int);
  gint DevicePixelsToGdkCoordRoundDown(int);
  GdkPoint DevicePixelsToGdkPointRoundDown(const LayoutDeviceIntPoint&);
  GdkRectangle DevicePixelsToGdkSizeRoundUp(const LayoutDeviceIntSize&);
  GdkRectangle DevicePixelsToGdkRectRoundOut(const LayoutDeviceIntRect&);
  GdkRectangle DevicePixelsToGdkRectRoundIn(const LayoutDeviceIntRect&);

  // From GDK
  int GdkCoordToDevicePixels(gint);
  LayoutDeviceIntPoint GdkPointToDevicePixels(const GdkPoint&);
  LayoutDeviceIntPoint GdkEventCoordsToDevicePixels(gdouble aX, gdouble aY);
  LayoutDeviceIntRect GdkRectToDevicePixels(const GdkRectangle&);
  LayoutDeviceIntMargin GtkBorderToDevicePixels(const GtkBorder&);

  bool WidgetTypeSupportsAcceleration() override;
  bool WidgetTypeSupportsNativeCompositing() override { return !mIsDragPopup; }

  nsresult SetSystemFont(const nsCString& aFontName) override;
  nsresult GetSystemFont(nsCString& aFontName) override;

  typedef enum {
    GTK_DECORATION_SYSTEM,  // CSD including shadows
    GTK_DECORATION_CLIENT,  // CSD without shadows
    GTK_DECORATION_NONE,    // WM does not support CSD at all
  } GtkWindowDecoration;
  /**
   * Get the support of Client Side Decoration by checking the desktop
   * environment.
   */
  static GtkWindowDecoration GetSystemGtkWindowDecoration();

  bool IsRemoteContent() const { return HasRemoteContent(); }
  void NativeMoveResizeWaylandPopupCallback(const GdkRectangle* aFinalSize,
                                            bool aFlippedX, bool aFlippedY);
  static bool IsToplevelWindowTransparent();

  static nsWindow* GetFocusedWindow();

  mozilla::UniquePtr<mozilla::widget::WaylandSurfaceLock> LockSurface();

#ifdef MOZ_WAYLAND
  // Use xdg-activation protocol to transfer focus from gFocusWindow to aWindow.
  static void TransferFocusToWaylandWindow(nsWindow* aWindow);
  void FocusWaylandWindow(const char* aTokenID);

  bool SetEGLNativeWindowSize(const LayoutDeviceIntSize& aEGLWindowSize);
  void WaylandDragWorkaround(GdkEventButton* aEvent);

  void CreateCompositorVsyncDispatcher() override;
  LayoutDeviceIntPoint GetNativePointerLockCenter() {
    return mNativePointerLockCenter;
  }
  void SetNativePointerLockCenter(
      const LayoutDeviceIntPoint& aLockCenter) override;
  void LockNativePointer() override;
  void UnlockNativePointer() override;
  LayoutDeviceIntSize GetMoveToRectPopupSize() const override {
    return mMoveToRectPopupSize;
  };
#endif

  void ResumeCompositorImpl();

  // Force hide this window, remove compositor etc. to avoid
  // rendering queue blocking (see Bug 1782948).
  void ClearRenderingQueue();

  bool ApplyEnterLeaveMutterWorkaround();

  void NotifyOcclusionState(mozilla::widget::OcclusionState aState) override;

  static nsWindow* GetWindow(GdkWindow* window);

  /**
   * Dispatch accessible window activate event for the top level window
   * accessible.
   */
  void DispatchActivateEventAccessible();

  void GtkWidgetDestroyHandler(GtkWidget* aWidget);

  void SetDragPopupSurface(RefPtr<gfxImageSurface> aDragPopupSurface,
                           const LayoutDeviceIntRegion& aInvalidRegion);

 protected:
  virtual ~nsWindow();

  // event handling code
  void DispatchActivateEvent(void);
  void DispatchDeactivateEvent(void);
  void DispatchPanGesture(mozilla::PanGestureInput& aPanInput);

  void RegisterTouchWindow() override;

  void NativeMoveResize(bool aMoved, bool aResized);

  void NativeShow(bool aAction);
  void SetHasMappedToplevel(bool aState);
  LayoutDeviceIntSize GetSafeWindowSize(LayoutDeviceIntSize aSize);

  void DispatchContextMenuEventFromMouseEvent(
      uint16_t domButton, GdkEventButton* aEvent,
      const mozilla::LayoutDeviceIntPoint& aRefPoint);

  void TryToShowNativeWindowMenu(GdkEventButton* aEvent);

  bool DoTitlebarAction(mozilla::LookAndFeel::TitlebarEvent aEvent,
                        GdkEventButton* aButtonEvent);

  void WaylandStartVsync();
  void WaylandStopVsync();
  void DestroyChildWindows();
  GtkWidget* GetToplevelWidget() const;
  nsWindow* GetContainerWindow() const;
  Window GetX11Window();
  void EnsureGdkWindow();
  void SetUrgencyHint(GtkWidget* top_window, bool state);
  void SetDefaultIcon(void);
  void SetWindowDecoration(BorderStyle aStyle);
  void InitButtonEvent(mozilla::WidgetMouseEvent& aEvent,
                       GdkEventButton* aGdkEvent,
                       const mozilla::LayoutDeviceIntPoint& aRefPoint,
                       bool isEraser = false);
  bool CheckForRollup(gdouble aMouseX, gdouble aMouseY, bool aIsWheel,
                      bool aAlwaysRollup);
  void RollupAllMenus() { CheckForRollup(0, 0, false, true); }
  void CheckForRollupDuringGrab() { RollupAllMenus(); }

  bool GetDragInfo(mozilla::WidgetMouseEvent* aMouseEvent, GdkWindow** aWindow,
                   gint* aButton, gint* aRootX, gint* aRootY);
  nsIWidgetListener* GetListener();

  nsWindow* GetTransientForWindowIfPopup();
  bool IsHandlingTouchSequence(GdkEventSequence* aSequence);

  void ResizeInt(const mozilla::Maybe<LayoutDeviceIntPoint>& aMove,
                 LayoutDeviceIntSize aSize);
  void NativeMoveResizeWaylandPopup(bool aMove, bool aResize);

  // Returns a window edge if the given point (in device pixels) is within a
  // resizer region of the window.
  // Only used when drawing decorations client side.
  mozilla::Maybe<GdkWindowEdge> CheckResizerEdge(const LayoutDeviceIntPoint&);

  GtkTextDirection GetTextDirection();

  bool DrawsToCSDTitlebar() const;
  bool ToplevelUsesCSD() const;

  void CreateAndPutGdkScrollEvent(mozilla::LayoutDeviceIntPoint aPoint,
                                  double aDeltaX, double aDeltaY);

  nsCString mGtkWindowAppClass;
  nsCString mGtkWindowAppName;
  nsCString mGtkWindowRoleName;
  void RefreshWindowClass();

  GtkWidget* mShell = nullptr;
  MozContainer* mContainer = nullptr;
  GdkWindow* mGdkWindow = nullptr;
#ifdef MOZ_WAYLAND
  RefPtr<mozilla::widget::WaylandSurface> mSurface;
#endif
  RefPtr<gfxImageSurface> mDragPopupSurface;
  LayoutDeviceIntRegion mDragPopupSurfaceRegion;

  PlatformCompositorWidgetDelegate* mCompositorWidgetDelegate = nullptr;

  // The actual size mode that's in effect.
  nsSizeMode mSizeMode = nsSizeMode_Normal;
  // The last size mode we've requested. This might not match mSizeMode if
  // there's a request to change the size mode in progress.
  nsSizeMode mLastSizeModeRequest = nsSizeMode_Normal;
  nsSizeMode mLastSizeModeBeforeFullscreen = nsSizeMode_Normal;

  float mAspectRatio = 0.0f;
  float mAspectRatioSaved = 0.0f;
  mozilla::Maybe<GtkOrientation> mAspectResizer;
  LayoutDeviceIntPoint mLastResizePoint;

  // Keep in sync with WaylandSurface::sNoScale
  constexpr static const int sNoScale = -1;
  int mCeiledScaleFactor = sNoScale;

  // The size requested, which might not be reflected in mBounds.  Used in
  // WaylandPopupSetDirectPosition() to remember intended size for popup
  // positioning, in LockAspect() to remember the intended aspect ratio, and
  // to remember a size requested while waiting for moved-to-rect when
  // OnSizeAllocate() might change mBounds.Size().
  LayoutDeviceIntSize mLastSizeRequest;
  // Same but for positioning. Used to track move requests.
  LayoutDeviceIntPoint mLastMoveRequest;
  // Margin from outer bounds to inner bounds _including CSD decorations_.
  LayoutDeviceIntMargin mClientMargin;
  // The part of mClientMargin that comes from our CSD decorations.
  LayoutDeviceIntMargin mCsdMargin;

  // This field omits duplicate scroll events caused by GNOME bug 726878.
  guint32 mLastScrollEventTime = GDK_CURRENT_TIME;
  mozilla::ScreenCoord mLastPinchEventSpan;

  struct TouchpadPinchGestureState {
    // Focus point of the PHASE_BEGIN event
    ScreenPoint mBeginFocus;

    // Focus point of the most recent PHASE_UPDATE event
    ScreenPoint mCurrentFocus;
  };

  // Used for handling touchpad pinch gestures
  ScreenPoint mCurrentTouchpadFocus;

  // Used for synthesizing touchpad pinch gestures
  TouchpadPinchGestureState mCurrentSynthesizedTouchpadPinch;

  // Used for synthesizing touchpad pan gestures
  struct TouchpadPanGestureState {
    mozilla::Maybe<TouchpadGesturePhase> mTouchpadGesturePhase;
    uint64_t mSavedObserver = 0;
  };

  // Used for synthesizing touchpad pan gestures
  TouchpadPanGestureState mCurrentSynthesizedTouchpadPan;

  // for touch event handling
  nsRefPtrHashtable<nsPtrHashKey<GdkEventSequence>, mozilla::dom::Touch>
      mTouches;

  // Upper bound on pending ConfigureNotify events to be dispatched to the
  // window. See bug 1225044.
  unsigned int mPendingConfigures = 0;

  // Window titlebar rendering mode, GTK_DECORATION_NONE if it's disabled
  // for this window.
  GtkWindowDecoration mGtkWindowDecoration = GTK_DECORATION_NONE;

  // Draggable titlebar region maintained by UpdateWindowDraggingRegion
  LayoutDeviceIntRegion mDraggableRegion;

  // The cursor cache
  static GdkCursor* gsGtkCursorCache[eCursorCount];

  // If true, draw our own window titlebar.
  bool mDrawInTitlebar = false;

  // This mutex protect window visibility changes.
  mozilla::Mutex mWindowVisibilityMutex;

  // This track real window visibility from OS perspective.
  // It's set by OnMap/OnUnmap which is based on Gtk events.
  mozilla::Atomic<bool, mozilla::Relaxed> mIsMapped;
  // Has this widget been destroyed yet?
  mozilla::Atomic<bool, mozilla::Relaxed> mIsDestroyed;
  // mIsShown tracks requested visible status from browser perspective, i.e.
  // if the window should be visible or now.
  bool mIsShown : 1;
  // mNeedsShow is set when browser requested to show this window but we failed
  // to do so for some reason (wrong window size for instance).
  // In such case we set mIsShown = true and mNeedsShow = true to indicate
  // that the window is not actually visible but we report to browser that
  // it is visible (mIsShown == true).
  bool mNeedsShow : 1;
  // is this widget enabled?
  bool mEnabled : 1;
  // has the native window for this been created yet?
  bool mCreated : 1;
  // whether we handle touch event
  bool mHandleTouchEvent : 1;
  // true if this is a drag and drop feedback popup
  bool mIsDragPopup : 1;
  bool mCompositedScreen : 1;
  bool mIsAccelerated : 1;
  bool mIsAlert : 1;
  bool mWindowShouldStartDragging : 1;
  bool mHasMappedToplevel : 1;
  bool mPanInProgress : 1;
  bool mPendingBoundsChange : 1;
  // Whether our pending bounds change event might change the window CSD margin.
  // This is needed because we might get two configures (one for mShell, one
  // for mContainer's window) in quick succession, which might cause us to send
  // spurious sequences of resizes if we don't do this on some compositors
  // (older mutter at least).
  bool mPendingBoundsChangeMayChangeCsdMargin : 1;
  // Draw titlebar with :backdrop css state (inactive/unfocused).
  bool mTitlebarBackdropState : 1;
  bool mAlwaysOnTop : 1;
  bool mIsTransparent : 1;
  // We can expect at least one size-allocate event after early resizes.
  bool mHasReceivedSizeAllocate : 1;
  bool mWidgetCursorLocked : 1;
  bool mUndecorated : 1;

  /*  Gkt creates popup in two incarnations - wl_subsurface and xdg_popup.
   *  Kind of popup is choosen before GdkWindow is mapped so we can change
   *  it only when GdkWindow is hidden.
   *
   *  Relevant Gtk code is at gdkwindow-wayland.c
   *  in should_map_as_popup() and should_map_as_subsurface()
   *
   *  wl_subsurface:
   *    - can't be positioned by move-to-rect
   *    - can stand outside popup widget hierarchy (has toplevel as parent)
   *    - don't have child popup widgets
   *
   *  xdg_popup:
   *    - can be positioned by move-to-rect
   *    - aligned in popup widget hierarchy, first one is attached to toplevel
   *    - has child (popup) widgets
   *
   *  Thus we need to map Firefox popup type to desired Gtk one:
   *
   *  wl_subsurface:
   *    - pernament panels
   *
   *  xdg_popup:
   *    - menus
   *    - autohide popups (hamburger menu)
   *    - extension popups
   *    - tooltips
   *
   *  We set mPopupTrackInHierarchy = false for pernament panels which
   *  are always mapped to toplevel and painted as wl_surfaces.
   */
  bool mPopupTrackInHierarchy : 1;
  bool mPopupTrackInHierarchyConfigured : 1;

  /* On X11 Gtk tends to ignore window position requests when gtk_window
   * is hidden. Save the position requests at mPopupPosition and apply
   * when the widget is shown.
   */
  bool mHiddenPopupPositioned : 1;

  // True when we're on compositing window manager and this
  // window is using visual with alpha channel.
  bool mHasAlphaVisual : 1;

  // When popup is anchored, mPopupPosition is relative to its parent popup.
  bool mPopupAnchored : 1;

  // When popup is context menu.
  bool mPopupContextMenu : 1;

  // Indicates that this popup matches layout setup so we can use parent popup
  // coordinates reliably.
  bool mPopupMatchesLayout : 1;

  /*  Indicates that popup setup was changed and
   *  we need to recalculate popup coordinates.
   */
  bool mPopupChanged : 1;

  // Popup is hidden only as a part of hierarchy tree update.
  bool mPopupTemporaryHidden : 1;

  // Popup is going to be closed and removed.
  bool mPopupClosed : 1;

  // Popup is positioned by gdk_window_move_to_rect()
  bool mPopupUseMoveToRect : 1;

  /* mWaitingForMoveToRectCallback is set when move-to-rect is called
   * and we're waiting for move-to-rect callback.
   *
   * If another position/resize request comes between move-to-rect call and
   * move-to-rect callback we set mMovedAfterMoveToRect/mResizedAfterMoveToRect.
   */
  bool mWaitingForMoveToRectCallback : 1;
  bool mMovedAfterMoveToRect : 1;
  bool mResizedAfterMoveToRect : 1;

  // Params used for popup placemend by GdkWindowMoveToRect.
  // When popup is only resized and not positioned,
  // we need to reuse last GdkWindowMoveToRect params to avoid
  // popup movement.
  struct WaylandPopupMoveToRectParams {
    LayoutDeviceIntRect mAnchorRect = {0, 0, 0, 0};
    GdkGravity mAnchorRectType = GDK_GRAVITY_NORTH_WEST;
    GdkGravity mPopupAnchorType = GDK_GRAVITY_NORTH_WEST;
    GdkAnchorHints mHints = GDK_ANCHOR_SLIDE;
    GdkPoint mOffset = {0, 0};
    bool mAnchorSet = false;
  };

  WaylandPopupMoveToRectParams mPopupMoveToRectParams;

  // Whether we've configured default clear color already.
  bool mConfiguredClearColor : 1;
  // Whether we've received a non-blank paint in which case we can reset the
  // clear color to transparent.
  bool mGotNonBlankPaint : 1;

  // Whether we need to retry capturing the mouse because we' re not mapped yet.
  bool mNeedsToRetryCapturingMouse : 1;

  // all of our DND stuff
  void InitDragEvent(mozilla::WidgetDragEvent& aEvent);

  float mLastMotionPressure = 0.0f;

  InputRegion mInputRegion;

  bool DragInProgress(void);

  void DispatchMissedButtonReleases(GdkEventCrossing* aGdkEvent);

  void ConfigureCompositor();

  bool IsAlwaysUndecoratedWindow() const;

  // nsBaseWidget
  WindowRenderer* GetWindowRenderer() override;
  void DidGetNonBlankPaint() override;

  void SetCompositorWidgetDelegate(CompositorWidgetDelegate* delegate) override;

  int32_t RoundsWidgetCoordinatesTo() override;

  void UpdateMozWindowActive();

  void ForceTitlebarRedraw();
  bool DoDrawTilebarCorners();
  bool IsChromeWindowTitlebar();

  void SetPopupWindowDecoration(bool aShowOnTaskbar);

  void ApplySizeConstraints();

  // Wayland Popup section
  GdkPoint WaylandGetParentPosition();
  bool WaylandPopupConfigure();
  bool WaylandPopupIsAnchored();
  bool WaylandPopupIsMenu();
  bool WaylandPopupIsContextMenu();
  bool WaylandPopupIsPermanent();
  // First popup means it's attached directly to toplevel window
  bool WaylandPopupIsFirst();
  bool IsWidgetOverflowWindow();
  void RemovePopupFromHierarchyList();
  void ShowWaylandPopupWindow();
  void HideWaylandPopupWindow(bool aTemporaryHidden, bool aRemoveFromPopupList);
  void ShowWaylandToplevelWindow();
  void HideWaylandToplevelWindow();
  void WaylandPopupHideTooltips();
  void WaylandPopupCloseOrphanedPopups();
  void AppendPopupToHierarchyList(nsWindow* aToplevelWindow);
  void WaylandPopupHierarchyHideTemporary();
  void WaylandPopupHierarchyShowTemporaryHidden();
  void WaylandPopupHierarchyCalculatePositions();
  bool IsInPopupHierarchy();
  void AddWindowToPopupHierarchy();
  void UpdateWaylandPopupHierarchy();
  void WaylandPopupHierarchyHideByLayout(
      nsTArray<nsIWidget*>* aLayoutWidgetHierarchy);
  void WaylandPopupHierarchyValidateByLayout(
      nsTArray<nsIWidget*>* aLayoutWidgetHierarchy);
  void CloseAllPopupsBeforeRemotePopup();
  void WaylandPopupHideClosedPopups();
  void WaylandPopupPrepareForMove();
  void WaylandPopupMoveImpl();
  void WaylandPopupMovePlain(int aX, int aY);
  bool WaylandPopupRemoveNegativePosition(int* aX = nullptr, int* aY = nullptr);
  bool WaylandPopupCheckAndGetAnchor(GdkRectangle* aPopupAnchor,
                                     GdkPoint* aOffset);
  bool WaylandPopupAnchorAdjustForParentPopup(GdkRectangle* aPopupAnchor,
                                              GdkPoint* aOffset);
  nsWindow* GetTopmostWindow();
  bool IsPopupInLayoutPopupChain(nsTArray<nsIWidget*>* aLayoutWidgetHierarchy,
                                 bool aMustMatchParent);
  void WaylandPopupMarkAsClosed();
  void WaylandPopupRemoveClosedPopups();
  void WaylandPopupSetDirectPosition();
  bool WaylandPopupFitsToplevelWindow(bool aMove);
  const WaylandPopupMoveToRectParams WaylandPopupGetPositionFromLayout();
  void WaylandPopupPropagateChangesToLayout(bool aMove, bool aResize);
  nsWindow* WaylandPopupFindLast(nsWindow* aPopup);
  GtkWindow* GetCurrentTopmostWindow() const;
  nsAutoCString GetFrameTag() const;
  nsCString GetPopupTypeName();
  bool IsPopupDirectionRTL();

#ifdef MOZ_LOGGING
  void LogPopupHierarchy();
  void LogPopupAnchorHints(int aHints);
  void LogPopupGravity(GdkGravity aGravity);
#endif

  // mPopupPosition is the original popup position/size from layout, set by
  // nsWindow::Move() or nsWindow::Resize().
  // Popup position is relative to main (toplevel) window.
  GdkPoint mPopupPosition{};

  // mRelativePopupPosition is popup position calculated against
  // recent popup parent window.
  GdkPoint mRelativePopupPosition{};

  // Toplevel window (first element) of linked list of Wayland popups. It's null
  // if we're the toplevel.
  RefPtr<nsWindow> mWaylandToplevel;

  // Next/Previous popups in Wayland popup hierarchy.
  RefPtr<nsWindow> mWaylandPopupNext;
  RefPtr<nsWindow> mWaylandPopupPrev;

  // When popup is resized by Gtk by move-to-rect callback,
  // we store final popup size here. Then we use mMoveToRectPopupSize size
  // in following popup operations unless mLayoutPopupSizeCleared is set.
  LayoutDeviceIntSize mMoveToRectPopupSize;

#ifdef MOZ_ENABLE_DBUS
  RefPtr<mozilla::widget::DBusMenuBar> mDBusMenuBar;
#endif

  struct LastMouseCoordinates {
    template <typename Event>
    void Set(Event* aEvent) {
      mX = aEvent->x;
      mY = aEvent->y;
      mRootX = aEvent->x_root;
      mRootY = aEvent->y_root;
    }

    float mX = 0.0f, mY = 0.0f;
    float mRootX = 0.0f, mRootY = 0.0f;
  } mLastMouseCoordinates;

  // We don't want to fire scroll event with the same timestamp as
  // smooth scroll event.
  guint32 mLastSmoothScrollEventTime = GDK_CURRENT_TIME;

  /**
   * |mIMContext| takes all IME related stuff.
   *
   * This is owned by the top-level nsWindow or the topmost child
   * nsWindow embedded in a non-Gecko widget.
   *
   * The instance is created when the top level widget is created.  And when
   * the widget is destroyed, it's released.  All child windows refer its
   * ancestor widget's instance.  So, one set of IM contexts is created for
   * all windows in a hierarchy.  If the children are released after the top
   * level window is released, the children still have a valid pointer,
   * however, IME doesn't work at that time.
   */
  RefPtr<mozilla::widget::IMContextWrapper> mIMContext;

#ifdef MOZ_X11
  mozilla::UniquePtr<mozilla::CurrentX11TimeGetter> mCurrentTimeGetter;
#endif
  static GtkWindowDecoration sGtkWindowDecoration;

  static bool sTransparentMainWindow;

  mozilla::UniquePtr<nsMenuBar> mMenuBar;

#ifdef ACCESSIBILITY
  RefPtr<mozilla::a11y::LocalAccessible> mRootAccessible;

  /**
   * Request to create the accessible for this window if it is top level.
   */
  void CreateRootAccessible();

  /**
   * Dispatch accessible event for the top level window accessible.
   *
   * @param  aEventType  [in] the accessible event type to dispatch
   */
  void DispatchEventToRootAccessible(uint32_t aEventType);

  /**
   * Dispatch accessible window deactivate event for the top level window
   * accessible.
   */
  void DispatchDeactivateEventAccessible();

  /**
   * Dispatch accessible window maximize event for the top level window
   * accessible.
   */
  void DispatchMaximizeEventAccessible();

  /**
   * Dispatch accessible window minize event for the top level window
   * accessible.
   */
  void DispatchMinimizeEventAccessible();

  /**
   * Dispatch accessible window restore event for the top level window
   * accessible.
   */
  void DispatchRestoreEventAccessible();
#endif

  void SetUserTimeAndStartupTokenForActivatedWindow();

  void KioskLockOnMonitor();

  void EmulateResizeDrag(GdkEventMotion* aEvent);

  void RequestRepaint(LayoutDeviceIntRegion& aRepaintRegion);

  bool DrawDragPopupSurface(cairo_t* cr);

#ifdef MOZ_X11
  typedef enum {
    GTK_WIDGET_COMPOSITED_DEFAULT = 0,
    GTK_WIDGET_COMPOSITED_DISABLED = 1,
    GTK_WIDGET_COMPOSITED_ENABLED = 2
  } WindowComposeRequest;
  void SetCompositorHint(WindowComposeRequest aState);
  bool ConfigureX11GLVisual();
#endif
#ifdef MOZ_WAYLAND
  RefPtr<mozilla::WaylandVsyncSource> mWaylandVsyncSource;
  RefPtr<mozilla::VsyncDispatcher> mWaylandVsyncDispatcher;
  LayoutDeviceIntPoint mNativePointerLockCenter;
  zwp_locked_pointer_v1* mLockedPointer = nullptr;
  zwp_relative_pointer_v1* mRelativePointer = nullptr;
#endif
  // An activation token from our environment (see handling of the
  // XDG_ACTIVATION_TOKEN/DESKTOP_STARTUP_ID) env vars.
  nsCString mWindowActivationTokenFromEnv;
  mozilla::widget::WindowSurfaceProvider mSurfaceProvider;
  GdkDragContext* mSourceDragContext = nullptr;
  bool mSourceDragContextActive = false;
  mozilla::Sides mResizableEdges{mozilla::SideBits::eAll};
  // Running in kiosk mode and requested to stay on specified monitor.
  // If monitor is removed minimize the window.
  mozilla::Maybe<int> mKioskMonitor;
  LayoutDeviceIntRegion mOpaqueRegion MOZ_GUARDED_BY(mOpaqueRegionLock);
  mutable mozilla::RWLock mOpaqueRegionLock{"nsWindow::mOpaqueRegion"};
};

#endif /* __nsWindow_h__ */
