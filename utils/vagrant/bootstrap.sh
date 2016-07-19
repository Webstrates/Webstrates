#!/usr/bin/env bash
sudo apt-get update
sudo apt-get install -y curl
sudo curl -sL https://deb.nodesource.com/setup | sudo bash -
sudo apt-get update
sudo apt-get install -y mongodb
sudo apt-get install -y git
sudo apt-get install -y nodejs
sudo apt-get install -y npm
git clone https://github.com/cklokmose/Webstrates.git
cd Webstrates
npm set strict-ssl false
sudo npm install
cd ..
sudo cat << EOF > webstrates_temp
start on runlevel [2345]
stop on runlevel [^2345]

console log
chdir /home/vagrant/Webstrates

respawn
respawn limit 20 5

exec node webstrates.js
EOF
sudo mv webstrates_temp /etc/init/webstrates.conf
sudo initctl reload-configuration
sudo start webstrates
