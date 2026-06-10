/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "EnterprisePolicies.h"
#include "TestDirHelpers.h"

#include <filesystem>
#include <format>
#include <fstream>
#include <string>
#include <string_view>
#include <windows.h>

namespace fs = std::filesystem;

class EnterprisePoliciesInDistributionTest : public ::testing::Test {
 protected:
  fs::path mTempDir;
  fs::path mDistDir;

  void SetUp() override { CreateDistributionDir(); }

  void TearDown() override { RemoveDir(mTempDir); }

  void WritePoliciesJson(std::string_view aContent) {
    std::ofstream out(mDistDir / "policies.json");
    out << aContent;
  }

 private:
  void CreateDistributionDir() {
    mTempDir = CreateTempDir();
    EXPECT_FALSE(mTempDir.empty());

    mDistDir = mTempDir / "distribution";
    std::error_code ec;
    fs::create_directory(mDistDir, ec);
    EXPECT_FALSE(ec);
  }
};

TEST_F(EnterprisePoliciesInDistributionTest, NoDistributionDir) {
  RemoveDir(mDistDir);
  EXPECT_FALSE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, EmptyFile) {
  WritePoliciesJson("");
  EXPECT_FALSE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, InvalidJson) {
  WritePoliciesJson("Test");
  EXPECT_FALSE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, NoPoliciesKey) {
  WritePoliciesJson(R"({"Test": true})");
  EXPECT_FALSE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, PoliciesIsNotObject) {
  WritePoliciesJson(R"({"policies": "Test"})");
  EXPECT_FALSE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, PoliciesIsArray) {
  WritePoliciesJson(R"({"policies": [1, 2, 3]})");
  EXPECT_FALSE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, EmptyPoliciesObject) {
  WritePoliciesJson(R"({"policies": {}})");
  EXPECT_FALSE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, SinglePolicy) {
  WritePoliciesJson(R"({"policies": {"Test": true}})");
  EXPECT_TRUE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, MultiplePolicies) {
  WritePoliciesJson(R"({
    "policies": {
      "Test1": true,
      "Test2": true
    }
  })");
  EXPECT_TRUE(EnterprisePolicies::InDistribution(mTempDir));
}

TEST_F(EnterprisePoliciesInDistributionTest, NestedPolicies) {
  WritePoliciesJson(R"({
    "policies": {
      "Test1": {
        "Test2": true
      }
    }
  })");
  EXPECT_TRUE(EnterprisePolicies::InDistribution(mTempDir));
}

class EnterprisePoliciesInRegistryTest : public ::testing::Test {
 protected:
  static inline const HKEY kHive{HKEY_CURRENT_USER};
  static constexpr std::wstring_view kBrand{L"Firefox Test"};
  static inline std::wstring mKeyPath;

  static void SetUpTestSuite() {
    mKeyPath = std::format(LR"(SOFTWARE\Policies\BrowserWorks\{})", kBrand);
  }

  HKEY CreateSubkey(std::wstring_view aSubpath = {}) {
    std::wstring fullPath{aSubpath.empty()
                              ? mKeyPath
                              : std::format(L"{}\\{}", mKeyPath, aSubpath)};
    HKEY key{};
    RegCreateKeyExW(kHive, fullPath.c_str(), 0, nullptr, 0, KEY_ALL_ACCESS,
                    nullptr, &key, nullptr);
    return key;
  }

  void SetStringValue(HKEY aKey, const wchar_t* aName, const wchar_t* aValue) {
    DWORD dataSize{static_cast<DWORD>((wcslen(aValue) + 1) * sizeof(wchar_t))};
    RegSetValueExW(aKey, aName, 0, REG_SZ,
                   reinterpret_cast<const BYTE*>(aValue), dataSize);
  }

  void SetDWORDValue(HKEY aKey, const wchar_t* aName, DWORD aValue) {
    RegSetValueExW(aKey, aName, 0, REG_DWORD,
                   reinterpret_cast<const BYTE*>(&aValue), sizeof(DWORD));
  }

  void TearDown() override { RegDeleteTreeW(kHive, mKeyPath.c_str()); }
};

TEST_F(EnterprisePoliciesInRegistryTest, IsEmpty) {
  HKEY key{CreateSubkey()};
  ASSERT_NE(key, nullptr);
  RegCloseKey(key);
  EXPECT_FALSE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasOneValue) {
  HKEY key{CreateSubkey()};
  ASSERT_NE(key, nullptr);
  SetStringValue(key, L"Test", L"true");
  RegCloseKey(key);
  EXPECT_TRUE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasOneKey) {
  HKEY subkey{CreateSubkey(L"Test")};
  ASSERT_NE(subkey, nullptr);
  RegCloseKey(subkey);
  EXPECT_TRUE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasMultipleKeys) {
  HKEY k1{CreateSubkey(L"Test1")};
  ASSERT_NE(k1, nullptr);
  RegCloseKey(k1);
  HKEY k2{CreateSubkey(L"Test2")};
  ASSERT_NE(k2, nullptr);
  RegCloseKey(k2);
  EXPECT_TRUE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasCertificatesKeyEmpty) {
  HKEY certKey{CreateSubkey(L"Certificates")};
  ASSERT_NE(certKey, nullptr);
  SetStringValue(certKey, L"ImportEnterpriseRoots", L"");
  RegCloseKey(certKey);
  EXPECT_TRUE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasCertificatesKeyWithOne) {
  HKEY certKey{CreateSubkey(L"Certificates")};
  ASSERT_NE(certKey, nullptr);
  SetDWORDValue(certKey, L"ImportEnterpriseRoots", 1);
  RegCloseKey(certKey);
  EXPECT_FALSE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasCertificatesKeyWithTrue) {
  HKEY certKey{CreateSubkey(L"Certificates")};
  ASSERT_NE(certKey, nullptr);
  SetStringValue(certKey, L"ImportEnterpriseRoots", L"true");
  RegCloseKey(certKey);
  EXPECT_FALSE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasCertificatesKeyPlusOtherKey) {
  HKEY certKey{CreateSubkey(L"Certificates")};
  ASSERT_NE(certKey, nullptr);
  SetDWORDValue(certKey, L"ImportEnterpriseRoots", 1);
  RegCloseKey(certKey);
  HKEY other{CreateSubkey(L"Test")};
  ASSERT_NE(other, nullptr);
  RegCloseKey(other);
  EXPECT_TRUE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasCertificatesKeyPlusOtherValue) {
  HKEY certKey{CreateSubkey(L"Certificates")};
  ASSERT_NE(certKey, nullptr);
  SetDWORDValue(certKey, L"ImportEnterpriseRoots", 1);
  SetStringValue(certKey, L"Test", L"true");
  RegCloseKey(certKey);
  EXPECT_TRUE(EnterprisePolicies::InRegistry(kBrand));
}

TEST_F(EnterprisePoliciesInRegistryTest, HasCertificatesKeyWithSubkey) {
  HKEY certKey{CreateSubkey(L"Certificates")};
  ASSERT_NE(certKey, nullptr);
  SetDWORDValue(certKey, L"ImportEnterpriseRoots", 1);
  RegCloseKey(certKey);
  HKEY inner{CreateSubkey(L"Certificates\\Test")};
  ASSERT_NE(inner, nullptr);
  RegCloseKey(inner);
  EXPECT_TRUE(EnterprisePolicies::InRegistry(kBrand));
}
