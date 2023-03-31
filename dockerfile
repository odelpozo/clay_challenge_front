FROM ubuntu:14 
# Install

RUN \ 
apt-get update -y && \ 
apt-get upgrade -y && \ 
apt-get install -yf && \ 
apt-get install -y curl bzip2 build-essential python git nodejs -yf && \ 
apt-get install -y npm

RUN curl -sL https://install.meteor.com | sed s/ — progress-bar/-sL/g | /bin/sh 

RUN mkdir -p /app 

ADD ./ /app

ADD deployenv/bin /deployenv/bin

RUN chmod +x /deployenv/bin/* & chmod -R 755 /app

EXPOSE 80

CMD [“/deployenv/bin/meteor.sh”]