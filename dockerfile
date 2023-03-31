FROM base/archlinux:latest 

 
RUN (printf "\nen_US.UTF-8 UTF-8\n" >> /etc/locale.gen) && (/usr/bin/locale-gen)

 
RUN curl https://install.meteor.com/ | sh
 
RUN useradd -m -G users -s /bin/bash meteor

USER meteor

RUN cd /tmp && meteor --version

ONBUILD USER meteor

ONBUILD RUN cd /home/meteor && mkdir app

ONBUILD COPY . /home/meteor/app/.

ONBUILD USER root

ONBUILD RUN chown -R meteor:meteor /home/meteor/app

ONBUILD RUN rm -rf /home/meteor/app/.meteor/local/*

ONBUILD USER meteor

EXPOSE 3000

CMD cd /home/meteor/app && meteor --production
