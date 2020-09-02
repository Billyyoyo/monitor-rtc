<template>
    <div class="hello">
        <div>
            <div v-if="!user">Site No:<input type="text" v-model="siteNo" style="width: 100px;">
                <button @click="login">Login</button>
            </div>
            <div v-if="user">
                <br>
                <div><input type="text" v-model="msg" style="width: 90%;">
                    <button @click="sendMsg">Send</button>
                </div>
                <br>
                <video ref="screenVideoView" playsinline width="320" height="180"></video>
                <video ref="cameraVideoView" playsinline width="320" height="180"></video>
                <audio ref="audioView" playsinline autoplay></audio>
            </div>
        </div>

    </div>
</template>

<script>

    module.exports = {
        components: {
            'Comp': httpVueLoader('./comp.vue')
        },
        data: function () {
            return {
                showJoin: true,
                siteNo: '1',
                msg: '',
                user: null
            }
        },
        mounted() {

        },
        methods: {
            login() {
                Client.getUserInfo(this.siteNo)
                    .then(result => {
                        this.user = result
                        this.join()
                    })
                    .catch(error => {
                        console.error(error)
                    })
            },
            join() {
                Client.main(this.user.roomId, this.user.id, {
                    showTip: this.showTip,
                    showError: this.showError,
                    needReconnect: this.needReconnect,
                    memberJoin: this.memberJoin,
                    memberLeave: this.memberLeave,
                    recvMessage: this.recvMessage,
                    onSendSuccess: this.onSendSuccess,
                    onMediaReady: this.onMediaReady,
                    onStreamComming: this.onStreamComming
                })
                voiceKeyListener.onPress = this.onVoiceKeyPress
                voiceKeyListener.onRelease = this.onVoiceKeyRelease
            },
            sendMsg() {
                Client.sendTextMessage(this.msg)
                this.msg = ''
            },
            onVoiceKeyPress() {
                Client.resumeVoiceProduce()
            },
            onVoiceKeyRelease() {
                Client.pauseVoiceProduce()
            },
            showTip(d) {
                console.log(d)
            },
            showError(d) {
                console.log(d)
            },
            needReconnect(d, fn) {
                console.log(d)
            },
            memberJoin(d) {
                console.log(d)
            },
            memberLeave(d) {
                console.log(d)
            },
            recvMessage(d) {
                console.log(d)
            },
            onSendSuccess(d) {
                console.log(d)
            },
            onMediaReady(peerId, mediaTag) {
                let player
                if (mediaTag === 'cam-video') {
                    player = this.$refs.cameraVideoView
                } else if (mediaTag === 'screen-video') {
                    player = this.$refs.screenVideoView
                } else if (mediaTag === 'cam-audio') {
                    player = this.$refs.audioView
                } else {
                    return
                }
                Client.subscribeToTrack(peerId, mediaTag)
                    .then(consumer => {
                        console.log('consumer info: ' + mediaTag + ' : ' + consumer.toString())
                        player.srcObject = new MediaStream([consumer.track.clone()])
                        player.consumer = consumer
                        player.play().then(() => {
                            console.log('start play ' + mediaTag)
                        }).catch(err => console.log('error happened in ' + mediaTag + ' |   ' + err))
                    })
            },
            onStreamComming(p, t, s) {
                console.log(p)
                console.log(t)
                console.log(s)
            }
        },
        destroyed() {
        }
    }
</script>

<style scoped>
    .hello {
    }
</style>