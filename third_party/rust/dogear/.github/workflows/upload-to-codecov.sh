#!/bin/sh

echo "GITHUB_ACTIONS:    ${GITHUB_ACTIONS}"
echo "GITHUB_HEAD_REF:   ${GITHUB_HEAD_REF}"
echo "GITHUB_REF:        ${GITHUB_REF}"
echo "GITHUB_REPOSITORY: ${GITHUB_REPOSITORY}"
echo "GITHUB_RUN_ID:     ${GITHUB_RUN_ID}"
echo "GITHUB_SHA:        ${GITHUB_SHA}"
echo "GITHUB_WORKFLOW:   ${GITHUB_WORKFLOW}"

# Make the reports file, which combines all reports together (currently we just have 1)
touch reports
cat cobertura.xml >> reports
echo '<<<<<< EOF' >> reports

# Calculate query params (most of this was taken from the bash uploader script)

# Use curl to urlencode values
urlencode() {
  echo "$1" | curl -Gso /dev/null -w "%{url_effective}" --data-urlencode @- "" | cut -c 3- | sed -e 's/%0A//'
}

service="github-actions"
branch="${GITHUB_REF#refs/heads/}"
if [  "$GITHUB_HEAD_REF" != "" ];
then
  # PR refs are in the format: refs/pull/7/merge
  pr="${GITHUB_REF#refs/pull/}"
  pr="${pr%/merge}"
  branch="${GITHUB_HEAD_REF}"
fi
commit="${GITHUB_SHA}"
slug=$(urlencode "${GITHUB_REPOSITORY}")
build="${GITHUB_RUN_ID}"
build_url=$(urlencode "http://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}")
job="$(urlencode "${GITHUB_WORKFLOW}")"

# actions/checkout runs in detached HEAD
mc=
if [ -n "$pr" ] && [ "$pr" != false ] && [ "$commit_o" == "" ];
then
  mc=$(git show --no-patch --format="%P" 2>/dev/null || echo "")

  if [[ "$mc" =~ ^[a-z0-9]{40}[[:space:]][a-z0-9]{40}$ ]];
  then
    mc=$(echo "$mc" | cut -d' ' -f2)
    echo "    Fixing merge commit SHA $commit -> $mc"
    commit=$mc
  elif [[ "$mc" = "" ]];
  then
    echo "$r->  Issue detecting commit SHA. Please run actions/checkout with fetch-depth > 1 or set to 0$x"
  fi
fi

query="commit=${commit}&branch=${branch}&build=${build}&job=${job}&build_url=${build_url}&slug=${slug}&service=${service}&pr=${pr}"
url="https://codecov.io/upload/v2?${query}"

echo "Codecov URL: ${url}"

curl -X POST --data-binary @reports ${url}
