/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsToolkitProfileService_h
#define nsToolkitProfileService_h

#include "mozilla/Components.h"
#include "mozilla/LinkedList.h"
#include "nsIObserver.h"
#include "nsIToolkitProfileService.h"
#include "nsIToolkitProfile.h"
#include "nsIFactory.h"
#include "nsSimpleEnumerator.h"
#include "nsProfileLock.h"
#include "nsINIParser.h"
#include "mozilla/MozPromise.h"
#include "nsProxyRelease.h"

class nsStartupLock;

struct CurrentProfileData {
  nsCString mPath;
  nsCString mStoreID;
  bool mShowSelector;
  bool mIsRelative;
};

struct IniData {
  nsCString mProfiles;
  nsCString mInstalls;
};

class nsToolkitProfile final
    : public nsIToolkitProfile,
      public mozilla::LinkedListElement<RefPtr<nsToolkitProfile>> {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSITOOLKITPROFILE

  friend class nsToolkitProfileService;

 private:
  ~nsToolkitProfile() = default;

  nsToolkitProfile(const nsACString& aName, nsIFile* aRootDir,
                   nsIFile* aLocalDir, bool aFromDB, const nsACString& aStoreID,
                   bool aShowProfileSelector);

  nsresult RemoveInternal(bool aRemoveFiles, bool aInBackground);

  friend class nsToolkitProfileLock;

  nsCString mName;
  nsCOMPtr<nsIFile> mRootDir;
  nsCOMPtr<nsIFile> mLocalDir;
  nsCString mStoreID;
  bool mShowProfileSelector;
  nsIProfileLock* mLock;
  uint32_t mIndex;
  nsCString mSection;
};

class nsToolkitProfileLock final : public nsIProfileLock {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPROFILELOCK

  nsresult Init(nsToolkitProfile* aProfile, nsIProfileUnlocker** aUnlocker);
  nsresult Init(nsIFile* aDirectory, nsIFile* aLocalDirectory,
                nsIProfileUnlocker** aUnlocker);

  nsToolkitProfileLock() = default;

 private:
  ~nsToolkitProfileLock();

  RefPtr<nsToolkitProfile> mProfile;
  nsCOMPtr<nsIFile> mDirectory;
  nsCOMPtr<nsIFile> mLocalDirectory;

  nsProfileLock mLock;
};

class nsToolkitProfileService final : public nsIToolkitProfileService,
                                      public nsIObserver {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSITOOLKITPROFILESERVICE
  NS_DECL_NSIOBSERVER

  nsresult SelectStartupProfile(int* aArgc, char* aArgv[], bool aIsResetting,
                                nsIFile** aRootDir, nsIFile** aLocalDir,
                                nsIToolkitProfile** aProfile, bool* aDidCreate,
                                bool* aWasDefaultSelection);
  nsresult CreateResetProfile(nsIToolkitProfile** aNewProfile);
  nsresult ApplyResetProfile(nsIToolkitProfile* aOldProfile);
  bool HasShowProfileSelector();
  void UpdateCurrentProfile();
  void CompleteStartup();

  using AsyncFlushPromise =
      mozilla::MozPromise<bool /* ignored */, nsresult, false>;

 private:
  friend class nsToolkitProfile;
  friend already_AddRefed<nsToolkitProfileService>
  NS_GetToolkitProfileService();

  nsToolkitProfileService();
  ~nsToolkitProfileService();

  nsresult Init();

  nsresult CreateTimesInternal(nsIFile* profileDir, const nsACString& aSource);
  void GetProfileByDir(nsIFile* aRootDir, nsIFile* aLocalDir,
                       nsToolkitProfile** aResult);
  already_AddRefed<nsToolkitProfile> GetProfileByStoreID(
      const nsACString& aStoreID);
  nsresult GetProfileDescriptor(nsToolkitProfile* aProfile, bool* aIsRelative,
                                nsACString& aDescriptor);
  bool IsProfileForCurrentInstall(nsToolkitProfile* aProfile);
  void ClearProfileFromOtherInstalls(nsToolkitProfile* aProfile);
  nsresult MaybeMakeDefaultDedicatedProfile(nsToolkitProfile* aProfile,
                                            bool* aResult);
  bool IsSnapEnvironment();
  bool UseLegacyProfiles();
  nsresult CreateDefaultProfile(const nsACString& aSource,
                                nsToolkitProfile** aResult);
  nsresult CreateUniqueProfile(nsIFile* aRootDir, const nsACString& aNamePrefix,
                               const nsACString& aSource,
                               nsToolkitProfile** aResult);
  nsresult CreateProfile(nsIFile* aRootDir, const nsACString& aName,
                         const nsACString& aSource, nsToolkitProfile** aResult);
  already_AddRefed<nsToolkitProfile> GetProfileByName(const nsACString& aName);
  void SetNormalDefault(nsToolkitProfile* aProfile);
  already_AddRefed<nsToolkitProfile> GetDefaultProfile();
  void FlushProfileData(
      const nsMainThreadPtrHandle<nsStartupLock>& aStartupLock,
      const CurrentProfileData* aProfileInfo);
  void BuildIniData(nsCString& aProfilesIniData, nsCString& aInstallsIniData);
  nsresult FlushData(const nsCString& aProfilesIniData,
                     const nsCString& aInstallsIniData);

  // Returns the known install hashes from the installs database. Modifying the
  // installs database is safe while iterating the returned array.
  nsTArray<nsCString> GetKnownInstalls();

  // Tracks whether SelectStartupProfile has been called.
  bool mStartupProfileSelected;
  // The  profiles loaded from profiles.ini.
  mozilla::LinkedList<RefPtr<nsToolkitProfile>> mProfiles;
  // The profile selected for use at startup, if it exists in profiles.ini.
  RefPtr<nsToolkitProfile> mCurrent;
  // The profile selected for this install in installs.ini.
  RefPtr<nsToolkitProfile> mDedicatedProfile;
  // The default profile used by non-dev-edition builds.
  RefPtr<nsToolkitProfile> mNormalDefault;
  // The profile used if mUseDevEditionProfile is true (the default on
  // dev-edition builds).
  RefPtr<nsToolkitProfile> mDevEditionDefault;
  // The directory that holds profiles.ini and profile directories.
  nsCOMPtr<nsIFile> mAppData;
  // The directory that holds the cache files for profiles.
  nsCOMPtr<nsIFile> mTempData;
  // The location of profiles.ini.
  nsCOMPtr<nsIFile> mProfileDBFile;
  // The location of installs.ini.
  nsCOMPtr<nsIFile> mInstallDBFile;
  // The data loaded from profiles.ini.
  nsINIParser mProfileDB;
  // The section in the profiles db for the current install.
  nsCString mInstallSection;
  // A legacy install section which may have been generated against an
  // installation directory with an incorrect case (see bug 1555319). It is only
  // really held here so that it can be overridden by tests.
  nsCString mLegacyInstallSection;
  // Whether to start with the selected profile by default.
  bool mStartWithLast;
  // True if during startup it appeared that this is the first run.
  bool mIsFirstRun;
  // True if the default profile is the separate dev-edition-profile.
  bool mUseDevEditionProfile;
  // True if this install should use a dedicated default profile.
  const bool mUseDedicatedProfile;
  nsCString mStartupReason;
  // Records the version of the profiles.ini file as it was when it was loaded
  // during startup.
  nsCString mStartupFileVersion;
  bool mMaybeLockProfile;
  // Holds the current application update channel. This is only really held
  // so it can be overridden in tests.
  nsCString mUpdateChannel;
  // Keep track of some attributes of the databases so we can tell if another
  // process has changed them.
  bool mProfileDBExists;
  int64_t mProfileDBFileSize;
  PRTime mProfileDBModifiedTime;
  nsCString mIniStatus;

  // A background task queue for the async flushing operations.
  nsCOMPtr<nsISerialEventTarget> mAsyncQueue;
  nsISerialEventTarget* AsyncQueue();

  static nsToolkitProfileService* gService;

  class ProfileEnumerator final : public nsSimpleEnumerator {
   public:
    NS_DECL_NSISIMPLEENUMERATOR

    const nsID& DefaultInterface() override {
      return NS_GET_IID(nsIToolkitProfile);
    }

    explicit ProfileEnumerator(nsToolkitProfile* first) { mCurrent = first; }

   private:
    RefPtr<nsToolkitProfile> mCurrent;
  };
};

already_AddRefed<nsToolkitProfileService> NS_GetToolkitProfileService();

#endif
