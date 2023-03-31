set -e
# user/group to run as
USER=root
GROUP=root
cd /app/
exec meteor run — settings settings.json — mobile-server $MOBILE_SERVER — port $METEOR_SERVER_PORT