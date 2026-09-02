/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsMathMLContainerFrame_h_
#define nsMathMLContainerFrame_h_

#include "mozilla/Likely.h"
#include "nsBlockFrame.h"
#include "nsContainerFrame.h"
#include "nsInlineFrame.h"
#include "nsMathMLFrame.h"
#include "nsMathMLOperators.h"

namespace mozilla {
class PresShell;
}  // namespace mozilla

/*
 * Base class for MathML container frames. It acts like an inferred
 * mrow. By default, this frame uses its Reflow() method to lay its
 * children horizontally and ensure that their baselines are aligned.
 * The Reflow() method relies upon Place() to position children.
 * By overloading Place() in derived classes, it is therefore possible
 * to position children in various customized ways.
 */

class nsMathMLContainerFrame : public nsContainerFrame, public nsMathMLFrame {
 public:
  nsMathMLContainerFrame(ComputedStyle* aStyle, nsPresContext* aPresContext,
                         ClassID aID)
      : nsContainerFrame(aStyle, aPresContext, aID) {}

  NS_DECL_QUERYFRAME_TARGET(nsMathMLContainerFrame)
  NS_DECL_QUERYFRAME
  NS_DECL_ABSTRACT_FRAME(nsMathMLContainerFrame)

  // --------------------------------------------------------------------------
  // Overloaded nsMathMLFrame methods -- see documentation in nsIMathMLFrame.h

  NS_IMETHOD
  Stretch(DrawTarget* aDrawTarget, StretchDirection aStretchDirection,
          nsBoundingMetrics& aContainerSize,
          ReflowOutput& aDesiredStretchSize) override;

  NS_IMETHOD
  UpdatePresentationDataFromChildAt(
      int32_t aFirstIndex, int32_t aLastIndex,
      MathMLPresentationFlags aFlagsValues,
      MathMLPresentationFlags aFlagsToUpdate) override {
    PropagatePresentationDataFromChildAt(this, aFirstIndex, aLastIndex,
                                         aFlagsValues, aFlagsToUpdate);
    return NS_OK;
  }

  // --------------------------------------------------------------------------
  // Overloaded nsContainerFrame methods -- see documentation in nsIFrame.h

  void AppendFrames(ChildListID aListID, nsFrameList&& aFrameList) override;

  void InsertFrames(ChildListID aListID, nsIFrame* aPrevFrame,
                    const nsLineList::iterator* aPrevFrameLine,
                    nsFrameList&& aFrameList) override;

  void RemoveFrame(DestroyContext&, ChildListID aListID,
                   nsIFrame* aOldFrame) override;

  nscoord IntrinsicISize(const mozilla::IntrinsicSizeInput& aInput,
                         mozilla::IntrinsicISizeType aType) override;

  /**
   * Return the intrinsic horizontal metrics of the frame's content area.
   */
  virtual void GetIntrinsicISizeMetrics(gfxContext* aRenderingContext,
                                        ReflowOutput& aDesiredSize);

  void Reflow(nsPresContext* aPresContext, ReflowOutput& aDesiredSize,
              const ReflowInput& aReflowInput,
              nsReflowStatus& aStatus) override;

  void BuildDisplayList(nsDisplayListBuilder* aBuilder,
                        const nsDisplayListSet& aLists) override;

  bool ComputeCustomOverflow(mozilla::OverflowAreas& aOverflowAreas) override;

  void MarkIntrinsicISizesDirty() override;

  // Notification when an attribute is changed. The MathML module uses the
  // following paradigm:
  //
  // 1. If the MathML frame class doesn't have any cached automatic data that
  //    depends on the attribute:
  //    1a. If the attribute is taken into account for the layout of the class
  //    then, we reflow (e.g., this happens with mfrac@linethickness).
  //    2b. Otherwise, we don't force any reflow.
  //
  // 2. If the MathML frame class has cached automatic data that depends on
  //    the attribute:
  //    2a. If the automatic data to update resides only within the descendants,
  //        we just re-layout them using ReLayoutChildren(this);
  //        (e.g., this happens with <ms>).
  //    2b. If the automatic data to update affects us in some way, we ask our
  //        parent to re-layout its children using ReLayoutChildren(mParent);
  //        Therefore, there is an overhead here in that our siblings are
  //        re-laid too (e.g., this happens with <munder>, <mover>,
  //        <munderover>).
  // nsresult AttributeChanged(int32_t aNameSpaceID, nsAtom* aAttribute,
  //                           AttrModType aModType) override;

  // helper function to apply mirroring to a horizontal coordinate, if needed.
  nscoord MirrorIfRTL(nscoord aParentWidth, nscoord aChildWidth,
                      nscoord aChildLeading) {
    return GetWritingMode().IsBidiRTL()
               ? aParentWidth - aChildWidth - aChildLeading
               : aChildLeading;
  }

  // --------------------------------------------------------------------------
  // Additional methods

 protected:
  enum class PlaceFlag : uint8_t {
    // If MeasureOnly is set, compute your desired size using the information
    // from GetReflowAndBoundingMetricsFor. However, child frames or other
    // elements should not be repositioned.
    // If MeasureOnly is not set, reflow is finished. You should position all
    // your children, and return your desired size. You should now use
    // FinishReflowChild() on your children to complete post-reflow operations.
    MeasureOnly,

    // If IntrinsicSize is set, the function is actually used to determine
    // intrinsic size (and consequently MeasureOnly is expected to be set too).
    // - It will use nsMathMLChar::GetMaxWidth instead of nsMathMLChar::Stretch.
    // - It will use IntrinsicISizeOffsets() for padding/border/margin instead
    //   of GetUsedBorder/Padding/Margin().
    // - etc
    IntrinsicSize,

    // If IgnoreBorderPadding is set, the function will complete without
    // adding the border/padding around the math layout. This can be used for
    // elements like <msqrt> that first layout their children as an <mrow>,
    // place some radical symbol on top of them and finally add its
    // padding/border around that radical symbol.
    IgnoreBorderPadding,

    // If DoNotAdjustForWidthAndHeight is set, the function will complete
    // without setting the computed width and height after the math layout. This
    // can be used similarly to IgnoreBorderPadding above.
    DoNotAdjustForWidthAndHeight,
  };
  using PlaceFlags = mozilla::EnumSet<PlaceFlag>;

  /* Place :
   * This method is used to measure or position child frames and other
   * elements.  It may be called any number of times with MeasureOnly
   * true, and the final call of the Reflow process before
   * returning from Reflow() or Stretch() will have MeasureOnly false
   * to position the elements.
   *
   * IMPORTANT: This method uses GetReflowAndBoundingMetricsFor() which must
   * have been set up with SaveReflowAndBoundingMetricsFor().
   *
   * The Place() method will use this information to compute the desired size
   * of the frame.
   *
   * @param aFlags [in] Flags to indicate the way the Place method should
   *        behave. See document for PlaceFlag above.
   *
   * @param aDesiredSize [out] parameter where you should return your desired
   *        size and your ascent/descent info. Compute your desired size using
   *        the information from GetReflowAndBoundingMetricsFor, and include
   *        any space you want for border/padding in the desired size you
   *        return.
   */
  virtual void Place(DrawTarget* aDrawTarget, const PlaceFlags& aFlags,
                     ReflowOutput& aDesiredSize);

  // helper to re-sync the automatic data in our children and notify our parent
  // to reflow us when changes (e.g., append/insert/remove) happen in our child
  // list
  virtual nsresult ChildListChanged();

  // helper to get the preferred size that a container frame should use to fire
  // the stretch on its stretchy child frames.
  enum class PreferredStretchSizeMode {
    Embellishments,
    EmbellishmentsIfSameStretchDirection,
  };
  void GetPreferredStretchSize(DrawTarget* aDrawTarget,
                               PreferredStretchSizeMode aMode,
                               StretchDirection aStretchDirection,
                               nsBoundingMetrics& aPreferredStretchSize);

  // helper used by mstyle, mphantom, mpadded and mrow in their implementation
  // of TransmitAutomaticData() to determine whether they are space-like.
  nsresult TransmitAutomaticDataForMrowLikeElement();

 public:
  /*
   * Helper to render the frame as a default mrow-like container when an error
   * (typically invalid markup) was encountered during reflow. Parameters are
   * the same as Place().
   */
  void PlaceAsMrow(DrawTarget* aDrawTarget, const PlaceFlags& aFlags,
                   ReflowOutput& aDesiredSize);

  /*
   * Helper to call ReportErrorToConsole for parse errors involving
   * attribute/value pairs.
   * @param aAttribute The attribute for which the parse error occurred.
   * @param aValue The value for which the parse error occurred.
   */
  nsresult ReportParseError(const char16_t* aAttribute, const char16_t* aValue);

  /*
   * Helper to call ReportErrorToConsole when certain tags
   * have more than the expected amount of children.
   */
  nsresult ReportChildCountError();

  /*
   * Helper to call ReportErrorToConsole when certain tags have
   * invalid child tags
   * @param aChildTag The tag which is forbidden in this context
   */
  nsresult ReportInvalidChildError(nsAtom* aChildTag);

  /*
   * Helper to call ReportToConsole when an error occurs.
   * @param aParams see nsContentUtils::ReportToConsole
   */
  nsresult ReportErrorToConsole(
      const char* aErrorMsgId,
      const nsTArray<nsString>& aParams = nsTArray<nsString>());

  // helper method to reflow a child frame. We are inline frames, and we don't
  // know our positions until reflow is finished. That's why we ask the
  // base method not to worry about our position.
  void ReflowChild(nsIFrame* aKidFrame, nsPresContext* aPresContext,
                   ReflowOutput& aDesiredSize, const ReflowInput& aReflowInput,
                   nsReflowStatus& aStatus);

  nsMargin GetBorderPaddingForPlace(const PlaceFlags& aFlags);

  struct WidthAndHeightForPlaceAdjustment {
    mozilla::Maybe<nscoord> width;
    mozilla::Maybe<nscoord> height;
  };
  WidthAndHeightForPlaceAdjustment GetWidthAndHeightForPlaceAdjustment(
      const PlaceFlags& aFlags);

  virtual bool IsMathContentBoxHorizontallyCentered() const { return false; }
  nscoord ApplyAdjustmentForWidthAndHeight(
      const PlaceFlags& aFlags, const WidthAndHeightForPlaceAdjustment& aSizes,
      ReflowOutput& aReflowOutput, nsBoundingMetrics& aBoundingMetrics);

 protected:
  // helper to add the inter-spacing when <math> is the immediate parent.
  // Since we don't (yet) handle the root <math> element ourselves, we need to
  // take special care of the inter-frame spacing on elements for which <math>
  // is the direct xml parent. This function will be repeatedly called from
  // left to right on the childframes of <math>, and by so doing it will
  // emulate the spacing that would have been done by a <mrow> container.
  // e.g., it fixes <math> <mi>f</mi> <mo>q</mo> <mi>f</mi> <mo>I</mo> </math>
  virtual nscoord FixInterFrameSpacing(ReflowOutput& aDesiredSize);

  // helper method to complete the post-reflow hook and ensure that embellished
  // operators don't terminate their Reflow without receiving a Stretch command.
  virtual nsresult FinalizeReflow(DrawTarget* aDrawTarget,
                                  ReflowOutput& aDesiredSize);

  // Record metrics of a child frame for recovery through the following method
  static void SaveReflowAndBoundingMetricsFor(
      nsIFrame* aFrame, const ReflowOutput& aReflowOutput,
      const nsBoundingMetrics& aBoundingMetrics);

  // helper method to facilitate getting the reflow and bounding metrics of a
  // child frame.  The argument aMathMLFrameType, when non null, will return
  // the 'type' of the frame, which is used to determine the inter-frame
  // spacing.
  // IMPORTANT: This function is only meant to be called in Place() methods as
  // the information is available only when set up with the above method
  // during Reflow/Stretch() and GetPrefISize().
  static void GetReflowAndBoundingMetricsFor(
      nsIFrame* aFrame, ReflowOutput& aReflowOutput,
      nsBoundingMetrics& aBoundingMetrics,
      MathMLFrameType* aMathMLFrameType = nullptr);

  // helper method to clear metrics saved with
  // SaveReflowAndBoundingMetricsFor() from all child frames.
  void ClearSavedChildMetrics();

  static nsMargin GetMarginForPlace(const PlaceFlags& aFlags, nsIFrame* aChild);

  static void InflateReflowAndBoundingMetrics(
      const nsMargin& aBorderPadding, ReflowOutput& aReflowOutput,
      nsBoundingMetrics& aBoundingMetrics);

  // helper to let the update of presentation data pass through
  // a subtree that may contain non-MathML container frames
  static void PropagatePresentationDataFor(
      nsIFrame* aFrame, MathMLPresentationFlags aFlagsValues,
      MathMLPresentationFlags aFlagsToUpdate);

 public:
  static void PropagatePresentationDataFromChildAt(
      nsIFrame* aParentFrame, int32_t aFirstChildIndex, int32_t aLastChildIndex,
      MathMLPresentationFlags aFlagsValues,
      MathMLPresentationFlags aFlagsToUpdate);

  // Sets flags on aFrame and all descendant frames
  static void PropagateFrameFlagFor(nsIFrame* aFrame, nsFrameState aFlags);

  // helper to let the rebuild of automatic data (presentation data
  // and embellishement data) walk through a subtree that may contain
  // non-MathML container frames. Note that this method re-builds the
  // automatic data in the children -- not in aParentFrame itself (except
  // for those particular operations that the parent frame may do in its
  // TransmitAutomaticData()). The reason it works this way is because
  // a container frame knows what it wants for its children, whereas children
  // have no clue who their parent is. For example, it is <mfrac> who knows
  // that its children have to be in scriptsizes, and has to transmit this
  // information to them. Hence, when changes occur in a child frame, the child
  // has to request the re-build from its parent. Unfortunately, the extra cost
  // for this is that it will re-sync in the siblings of the child as well.
  static void RebuildAutomaticDataForChildren(nsIFrame* aParentFrame);

  // helper to blow away the automatic data cached in a frame's subtree and
  // re-layout its subtree to reflect changes that may have happen. In the
  // event where aParentFrame isn't a MathML frame, it will first walk up to
  // the ancestor that is a MathML frame, and re-layout from there -- this is
  // to guarantee that automatic data will be rebuilt properly. Note that this
  // method re-builds the automatic data in the children -- not in the parent
  // frame itself (except for those particular operations that the parent frame
  // may do do its TransmitAutomaticData()). @see
  // RebuildAutomaticDataForChildren
  //
  // aBits are the bits to pass to FrameNeedsReflow() when we call it.
  static nsresult ReLayoutChildren(nsIFrame* aParentFrame);

 protected:
  // Helper method which positions child frames as an <mrow> on given baseline
  // y = aBaseline starting from x = aOffsetX, calling FinishReflowChild()
  // on the frames.
  void PositionRowChildFrames(nscoord aOffsetX, nscoord aBaseline,
                              bool aAddOperatorSpacing = true);

  // A variant on FinishAndStoreOverflow() that uses the union of child
  // overflows, the frame bounds, and mBoundingMetrics to set and store the
  // overflow.
  void GatherAndStoreOverflow(ReflowOutput* aMetrics);

  /**
   * Recompute mIntrinsicISize if it's not already up to date.
   */
  void UpdateIntrinsicISize(gfxContext* aRenderingContext);

  nscoord mIntrinsicISize = NS_INTRINSIC_ISIZE_UNKNOWN;

  nscoord mBlockStartAscent = 0;

 private:
  class RowChildFrameIterator;
  friend class RowChildFrameIterator;
};

// --------------------------------------------------------------------------
// Currently, to benefit from line-breaking inside the <math> element, <math> is
// simply mapping to nsBlockFrame or nsInlineFrame.
// A separate implemention needs to provide:
// 1) line-breaking
// 2) proper inter-frame spacing
// 3) firing of Stretch() (in which case FinalizeReflow() would have to be
//    cleaned)
// Issues: If/when mathml becomes a pluggable component, the separation will be
// needed.
class nsMathMLmathBlockFrame final : public nsBlockFrame {
 public:
  NS_DECL_QUERYFRAME
  NS_DECL_FRAMEARENA_HELPERS(nsMathMLmathBlockFrame)

  friend nsContainerFrame* NS_NewMathMLmathBlockFrame(
      mozilla::PresShell* aPresShell, ComputedStyle* aStyle);

  // beware, mFrames is not set by nsBlockFrame
  // cannot use mFrames{.FirstChild()|.etc} since the block code doesn't set
  // mFrames
  void SetInitialChildList(ChildListID aListID,
                           nsFrameList&& aChildList) override {
    MOZ_ASSERT(aListID == mozilla::FrameChildListID::Principal,
               "unexpected frame list");
    nsBlockFrame::SetInitialChildList(aListID, std::move(aChildList));
    if (aListID == mozilla::FrameChildListID::Principal) {
      // re-resolve our subtree to set any mathml-expected data
      nsMathMLContainerFrame::RebuildAutomaticDataForChildren(this);
    }
  }

  void AppendFrames(ChildListID aListID, nsFrameList&& aFrameList) override {
    NS_ASSERTION(aListID == mozilla::FrameChildListID::Principal ||
                     aListID == mozilla::FrameChildListID::NoReflowPrincipal,
                 "unexpected frame list");
    nsBlockFrame::AppendFrames(aListID, std::move(aFrameList));
    if (MOZ_LIKELY(aListID == mozilla::FrameChildListID::Principal)) {
      nsMathMLContainerFrame::ReLayoutChildren(this);
    }
  }

  void InsertFrames(ChildListID aListID, nsIFrame* aPrevFrame,
                    const nsLineList::iterator* aPrevFrameLine,
                    nsFrameList&& aFrameList) override {
    NS_ASSERTION(aListID == mozilla::FrameChildListID::Principal ||
                     aListID == mozilla::FrameChildListID::NoReflowPrincipal,
                 "unexpected frame list");
    nsBlockFrame::InsertFrames(aListID, aPrevFrame, aPrevFrameLine,
                               std::move(aFrameList));
    if (MOZ_LIKELY(aListID == mozilla::FrameChildListID::Principal)) {
      nsMathMLContainerFrame::ReLayoutChildren(this);
    }
  }

  void RemoveFrame(DestroyContext& aContext, ChildListID aListID,
                   nsIFrame* aOldFrame) override {
    NS_ASSERTION(aListID == mozilla::FrameChildListID::Principal ||
                     aListID == mozilla::FrameChildListID::NoReflowPrincipal,
                 "unexpected frame list");
    nsBlockFrame::RemoveFrame(aContext, aListID, aOldFrame);
    if (MOZ_LIKELY(aListID == mozilla::FrameChildListID::Principal)) {
      nsMathMLContainerFrame::ReLayoutChildren(this);
    }
  }

  // See nsIMathMLFrame.h
  bool IsMrowLike() {
    return mFrames.FirstChild() != mFrames.LastChild() || !mFrames.FirstChild();
  }

 protected:
  explicit nsMathMLmathBlockFrame(ComputedStyle* aStyle,
                                  nsPresContext* aPresContext)
      : nsBlockFrame(aStyle, aPresContext, kClassID) {}
  virtual ~nsMathMLmathBlockFrame() = default;
};

// --------------

class nsMathMLmathInlineFrame final : public nsInlineFrame,
                                      public nsMathMLFrame {
 public:
  NS_DECL_QUERYFRAME
  NS_DECL_FRAMEARENA_HELPERS(nsMathMLmathInlineFrame)

  friend nsContainerFrame* NS_NewMathMLmathInlineFrame(
      mozilla::PresShell* aPresShell, ComputedStyle* aStyle);

  void SetInitialChildList(ChildListID aListID,
                           nsFrameList&& aChildList) override {
    NS_ASSERTION(aListID == mozilla::FrameChildListID::Principal,
                 "unexpected frame list");
    nsInlineFrame::SetInitialChildList(aListID, std::move(aChildList));
    // re-resolve our subtree to set any mathml-expected data
    nsMathMLContainerFrame::RebuildAutomaticDataForChildren(this);
  }

  void AppendFrames(ChildListID aListID, nsFrameList&& aFrameList) override {
    NS_ASSERTION(aListID == mozilla::FrameChildListID::Principal ||
                     aListID == mozilla::FrameChildListID::NoReflowPrincipal,
                 "unexpected frame list");
    nsInlineFrame::AppendFrames(aListID, std::move(aFrameList));
    if (MOZ_LIKELY(aListID == mozilla::FrameChildListID::Principal)) {
      nsMathMLContainerFrame::ReLayoutChildren(this);
    }
  }

  void InsertFrames(ChildListID aListID, nsIFrame* aPrevFrame,
                    const nsLineList::iterator* aPrevFrameLine,
                    nsFrameList&& aFrameList) override {
    NS_ASSERTION(aListID == mozilla::FrameChildListID::Principal ||
                     aListID == mozilla::FrameChildListID::NoReflowPrincipal,
                 "unexpected frame list");
    nsInlineFrame::InsertFrames(aListID, aPrevFrame, aPrevFrameLine,
                                std::move(aFrameList));
    if (MOZ_LIKELY(aListID == mozilla::FrameChildListID::Principal)) {
      nsMathMLContainerFrame::ReLayoutChildren(this);
    }
  }

  void RemoveFrame(DestroyContext& aContext, ChildListID aListID,
                   nsIFrame* aOldFrame) override {
    NS_ASSERTION(aListID == mozilla::FrameChildListID::Principal ||
                     aListID == mozilla::FrameChildListID::NoReflowPrincipal,
                 "unexpected frame list");
    nsInlineFrame::RemoveFrame(aContext, aListID, aOldFrame);
    if (MOZ_LIKELY(aListID == mozilla::FrameChildListID::Principal)) {
      nsMathMLContainerFrame::ReLayoutChildren(this);
    }
  }

  bool IsMrowLike() override {
    return mFrames.FirstChild() != mFrames.LastChild() || !mFrames.FirstChild();
  }

 protected:
  explicit nsMathMLmathInlineFrame(ComputedStyle* aStyle,
                                   nsPresContext* aPresContext)
      : nsInlineFrame(aStyle, aPresContext, kClassID) {}

  virtual ~nsMathMLmathInlineFrame() = default;
};

#endif /* nsMathMLContainerFrame_h_ */
