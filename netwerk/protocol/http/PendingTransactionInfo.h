/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef PendingTransactionInfo_h_
#define PendingTransactionInfo_h_

#include "DnsAndConnectSocket.h"

namespace mozilla {
namespace net {

class PendingTransactionInfo final : public ARefBase {
 public:
  explicit PendingTransactionInfo(nsHttpTransaction* trans)
      : mTransaction(trans) {}

  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(PendingTransactionInfo, override)

  void PrintDiagnostics(nsCString& log);

  // Return true if the transaction has claimed a DnsAndConnectSocket or
  // a connection in TLS handshake phase.
  bool IsAlreadyClaimedInitializingConn();

  // This function return a weak poointer to ConnectionAttempt.
  // The pointer is used by the caller(ConnectionEntry) to remove the
  // ConnectionAttempt from the internal list. PendingTransactionInfo
  // cannot perform this operation.
  [[nodiscard]] nsWeakPtr ForgetConnectionAttemptAndActiveConn();

  // Remember associated ConnectionAttempt.
  void RememberConnectionAttempt(ConnectionAttempt* sock);
  // Similar as above, but for a ActiveConn that is performing a TLS handshake
  // and has only a NullTransaction associated.
  bool TryClaimingActiveConn(HttpConnectionBase* conn);

  nsHttpTransaction* Transaction() const { return mTransaction; }

 private:
  RefPtr<nsHttpTransaction> mTransaction;
  nsWeakPtr mConnectionAttempt;
  nsWeakPtr mActiveConn;

  ~PendingTransactionInfo();
};

class PendingComparator {
 public:
  bool Equals(const PendingTransactionInfo* aPendingTrans,
              const nsAHttpTransaction* aTrans) const {
    return aPendingTrans->Transaction() == aTrans;
  }
};

}  // namespace net
}  // namespace mozilla

#endif  // !PendingTransactionInfo_h_
